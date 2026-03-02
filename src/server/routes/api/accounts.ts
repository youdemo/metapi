import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq, gte, lt } from 'drizzle-orm';
import { refreshBalance } from '../../services/balanceService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { refreshModelsForAccount, rebuildTokenRoutesFromAvailability } from '../../services/modelService.js';
import { ensureDefaultTokenForAccount, syncTokensFromUpstream } from '../../services/accountTokenService.js';
import { guessPlatformUserIdFromUsername, mergeAccountExtraConfig, resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import { encryptAccountPassword } from '../../services/accountCredentialService.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseCheckinRewardAmount } from '../../services/checkinRewardParser.js';
import { estimateRewardWithTodayIncomeFallback } from '../../services/todayIncomeRewardService.js';
import { getLocalDayRangeUtc } from '../../services/localTimeService.js';
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from '../../services/accountHealthService.js';
import { appendSessionTokenRebindHint } from '../../services/alertRules.js';
import { withExplicitProxyRequestInit } from '../../services/siteProxy.js';

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  state: RuntimeHealthState;
  message: string;
};

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function getNextAccountSortOrder(): number {
  const rows = db.select({ sortOrder: schema.accounts.sortOrder }).from(schema.accounts).all();
  const max = rows.reduce((currentMax, row) => Math.max(currentMax, row.sortOrder || 0), -1);
  return max + 1;
}

function summarizeAccountHealthRefresh(results: AccountHealthRefreshResult[]) {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === 'healthy').length,
    unhealthy: results.filter((item) => item.state === 'unhealthy').length,
    degraded: results.filter((item) => item.state === 'degraded').length,
    disabled: results.filter((item) => item.state === 'disabled').length,
    unknown: results.filter((item) => item.state === 'unknown').length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  };
}

async function refreshRuntimeHealthForRow(row: AccountWithSiteRow): Promise<AccountHealthRefreshResult> {
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;

  if ((row.accounts.status || 'active') === 'disabled' || (row.sites.status || 'active') === 'disabled') {
    setAccountRuntimeHealth(accountId, {
      state: 'disabled',
      reason: '账号或站点已禁用',
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: 'disabled',
      message: '账号或站点已禁用',
    };
  }

  try {
    await refreshBalance(accountId);
    const refreshedAccount = db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const runtimeHealth = buildRuntimeHealthForAccount({
      accountStatus: refreshedAccount?.status || row.accounts.status,
      siteStatus: row.sites.status,
      extraConfig: refreshedAccount?.extraConfig ?? row.accounts.extraConfig,
    });

    return {
      accountId,
      username,
      siteName,
      status: runtimeHealth.state === 'unhealthy' ? 'failed' : 'success',
      state: runtimeHealth.state,
      message: runtimeHealth.reason,
    };
  } catch (error: any) {
    const message = String(error?.message || '健康检查失败');
    setAccountRuntimeHealth(accountId, {
      state: 'unhealthy',
      reason: message,
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'failed',
      state: 'unhealthy',
      message,
    };
  }
}

async function executeRefreshAccountRuntimeHealth(accountId?: number) {
  const rows = db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(accountId as number)
    ? rows.filter((row) => row.accounts.id === accountId)
    : rows;

  const results: AccountHealthRefreshResult[] = [];
  for (const row of targetRows) {
    results.push(await refreshRuntimeHealthForRow(row));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}

export async function accountsRoutes(app: FastifyInstance) {
  // List all accounts (with site info)
  app.get('/api/accounts', async () => {
    const rows = db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id)).all();

    const { localDay, startUtc, endUtc } = getLocalDayRangeUtc();

    // Aggregate today's spend per account from proxy logs
    const todayLogs = db.select().from(schema.proxyLogs)
      .where(and(gte(schema.proxyLogs.createdAt, startUtc), lt(schema.proxyLogs.createdAt, endUtc)))
      .all();
    const spendByAccount: Record<number, number> = {};
    for (const log of todayLogs) {
      if (log.accountId == null) continue;
      const cost = typeof log.estimatedCost === 'number' ? log.estimatedCost : 0;
      spendByAccount[log.accountId] = (spendByAccount[log.accountId] || 0) + cost;
    }

    // Aggregate today's checkin rewards per account
    const todayCheckins = db.select().from(schema.checkinLogs)
      .where(and(
        gte(schema.checkinLogs.createdAt, startUtc),
        lt(schema.checkinLogs.createdAt, endUtc),
        eq(schema.checkinLogs.status, 'success'),
      ))
      .all();
    const rewardByAccount: Record<number, number> = {};
    const successCountByAccount: Record<number, number> = {};
    const parsedRewardCountByAccount: Record<number, number> = {};
    for (const log of todayCheckins) {
      successCountByAccount[log.accountId] = (successCountByAccount[log.accountId] || 0) + 1;
      const rewardNum = parseCheckinRewardAmount(log.reward) || parseCheckinRewardAmount(log.message);
      if (rewardNum <= 0) continue;
      rewardByAccount[log.accountId] = (rewardByAccount[log.accountId] || 0) + rewardNum;
      parsedRewardCountByAccount[log.accountId] = (parsedRewardCountByAccount[log.accountId] || 0) + 1;
    }

    return rows.map((r) => ({
      ...r.accounts,
      site: r.sites,
      todaySpend: Math.round((spendByAccount[r.accounts.id] || 0) * 1_000_000) / 1_000_000,
      todayReward: Math.round(estimateRewardWithTodayIncomeFallback({
        day: localDay,
        successCount: successCountByAccount[r.accounts.id] || 0,
        parsedRewardCount: parsedRewardCountByAccount[r.accounts.id] || 0,
        rewardSum: rewardByAccount[r.accounts.id] || 0,
        extraConfig: r.accounts.extraConfig,
      }) * 1_000_000) / 1_000_000,
      runtimeHealth: buildRuntimeHealthForAccount({
        accountStatus: r.accounts.status,
        siteStatus: r.sites.status,
        extraConfig: r.accounts.extraConfig,
      }),
    }));
  });

  // Login to a site and auto-create account
  app.post<{ Body: { siteId: number; username: string; password: string } }>('/api/accounts/login', async (request) => {
    const { siteId, username, password } = request.body;

    // Get site info
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return { success: false, message: 'site not found' };

    // Get platform adapter
    const adapter = getAdapter(site.platform);
    if (!adapter) return { success: false, message: `婵炴垶鎸哥粔鐢稿极椤曗偓楠炴劖鎷呴悜妯兼殸濡ょ姷鍋涢崯鑳亹? ${site.platform}` };

    // Login to the target site
    const loginResult = await adapter.login(site.url, username, password);
    if (!loginResult.success || !loginResult.accessToken) {
      return { success: false, message: loginResult.message || 'login failed' };
    }

    const guessedPlatformUserId = guessPlatformUserIdFromUsername(username);

    // Auto-fetch API token(s)
    let apiToken: string | null = null;
    let apiTokens: Array<{ name?: string | null; key?: string | null; enabled?: boolean | null }> = [];
    try {
      apiToken = await adapter.getApiToken(site.url, loginResult.accessToken, guessedPlatformUserId);
    } catch { }
    try {
      apiTokens = await adapter.getApiTokens(site.url, loginResult.accessToken, guessedPlatformUserId);
    } catch { }

    const preferredApiToken = apiTokens.find((token) => token.enabled !== false && token.key)?.key || apiToken || null;
    const existing = db.select().from(schema.accounts)
      .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.username, username)))
      .get();

    const extraConfigPatch: Record<string, unknown> = {
      autoRelogin: {
        username,
        passwordCipher: encryptAccountPassword(password),
        updatedAt: new Date().toISOString(),
      },
    };
    if (guessedPlatformUserId) {
      extraConfigPatch.platformUserId = guessedPlatformUserId;
    }
    const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, extraConfigPatch);

    // Create or update account
    let accountId = existing?.id;
    if (existing) {
      db.update(schema.accounts).set({
        accessToken: loginResult.accessToken,
        apiToken: preferredApiToken || undefined,
        checkinEnabled: true,
        status: 'active',
        extraConfig,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.accounts.id, existing.id)).run();
    } else {
      const created = db.insert(schema.accounts).values({
        siteId,
        username,
        accessToken: loginResult.accessToken,
        apiToken: preferredApiToken || undefined,
        checkinEnabled: true,
        extraConfig,
        isPinned: false,
        sortOrder: getNextAccountSortOrder(),
      }).returning().get();
      accountId = created.id;
    }

    const result = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId!)).get();
    if (!result) {
      return { success: false, message: 'account create failed' };
    }

    if (apiTokens.length > 0) {
      try {
        syncTokensFromUpstream(result.id, apiTokens);
      } catch { }
    } else if (preferredApiToken) {
      try {
        ensureDefaultTokenForAccount(result.id, preferredApiToken, { name: 'default', source: 'sync' });
      } catch { }
    }

    // Auto-refresh balance
    try { await refreshBalance(result.id); } catch { }
    try {
      await refreshModelsForAccount(result.id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, result.id)).get();
    return {
      success: true,
      account,
      apiTokenFound: !!preferredApiToken,
      tokenCount: apiTokens.length,
      reusedAccount: !!existing,
    };
  });

  // Verify a token against a site - auto-detects token type (session vs API key)
  app.post<{ Body: { siteId: number; accessToken: string; platformUserId?: number } }>('/api/accounts/verify-token', async (request) => {
    const { siteId, accessToken, platformUserId } = request.body;
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return { success: false, message: 'site not found' };

    const adapter = getAdapter(site.platform);
    if (!adapter) return { success: false, message: `婵炴垶鎸哥粔鐢稿极椤曗偓楠炴劖鎷呴悜妯兼殸濡ょ姷鍋涢崯鑳亹? ${site.platform}` };

    let result: any;
    try {
      result = await adapter.verifyToken(site.url, accessToken, platformUserId);
    } catch (err: any) {
      return {
        success: false,
        message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
      };
    }

    if (result.tokenType === 'session') {
      return {
        success: true,
        tokenType: 'session',
        userInfo: result.userInfo,
        balance: result.balance,
        apiToken: result.apiToken,
      };
    }

    if (result.tokenType === 'apikey') {
      return {
        success: true,
        tokenType: 'apikey',
        modelCount: result.models?.length || 0,
        models: result.models?.slice(0, 10),
      };
    }

    // Try to explain unknown failures: missing user id vs anti-bot challenge page.
    type VerifyFailureReason = 'needs-user-id' | 'shield-blocked' | null;
    const detectVerifyFailureReason = async (): Promise<VerifyFailureReason> => {
      const parseFailureReason = (bodyText: string, contentType: string): VerifyFailureReason => {
        const text = bodyText || '';
        const ct = (contentType || '').toLowerCase();
        if (ct.includes('text/html') && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) {
          return 'shield-blocked';
        }

        try {
          const body = JSON.parse(text) as any;
          const message = typeof body?.message === 'string' ? body.message : '';
          if (/mismatch|new-api-user|user id/i.test(message)) return 'needs-user-id';
          if (/shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)) return 'shield-blocked';
        } catch { }

        return null;
      };

      try {
        const { fetch } = await import('undici');
        const candidates = new Set<string>();
        const trimmed = (accessToken || '').trim();
        const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
        if (raw) {
          if (raw.includes('=')) candidates.add(raw);
          candidates.add(`session=${raw}`);
          candidates.add(`token=${raw}`);
        }

        const headerVariants: Record<string, string>[] = [
          { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'New-Api-User': '0' },
        ];

        for (const cookie of candidates) {
          headerVariants.push({
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          });
        }

        for (const headers of headerVariants) {
          try {
            const testRes = await fetch(`${site.url}/api/user/self`, withExplicitProxyRequestInit(site.proxyUrl, { headers }));
            const bodyText = await testRes.text();
            const contentType = testRes.headers.get('content-type') || '';
            const reason = parseFailureReason(bodyText, contentType);
            if (reason) return reason;
          } catch { }
        }
      } catch { }

      return null;
    };

    const failureReason = await detectVerifyFailureReason();
    if (failureReason === 'needs-user-id') {
      return {
        success: false,
        needsUserId: true,
        message: 'This site requires a user ID. Please fill in your site user ID.',
      };
    }

    if (failureReason === 'shield-blocked') {
      return {
        success: false,
        shieldBlocked: true,
        message: 'This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.',
      };
    }

    return {
      success: false,
      message: 'Token invalid: cannot use it as session cookie or API key',
    };
  });

  app.post<{ Params: { id: string }; Body: { accessToken: string; platformUserId?: number } }>(
    '/api/accounts/:id/rebind-session',
    async (request, reply) => {
      const accountId = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ success: false, message: '账号 ID 无效' });
      }

      const nextAccessToken = (request.body?.accessToken || '').trim();
      if (!nextAccessToken) {
        return reply.code(400).send({ success: false, message: '请提供新的 Session Token' });
      }

      const row = db.select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!row) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }

      const account = row.accounts;
      const site = row.sites;
      const adapter = getAdapter(site.platform);
      if (!adapter) {
        return reply.code(400).send({ success: false, message: `platform not supported: ${site.platform}` });
      }

      const bodyPlatformUserId = Number.parseInt(String(request.body?.platformUserId ?? ''), 10);
      const candidatePlatformUserId = Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
        ? bodyPlatformUserId
        : resolvePlatformUserId(account.extraConfig, account.username);

      let verifyResult: any;
      try {
        verifyResult = await adapter.verifyToken(site.url, nextAccessToken, candidatePlatformUserId);
      } catch (err: any) {
        return reply.code(400).send({
          success: false,
          message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
        });
      }

      if (verifyResult?.tokenType !== 'session') {
        return reply.code(400).send({
          success: false,
          message: '新的 Token 验证失败：请提供可用的 Session Token',
        });
      }

      const nextUsernameRaw = typeof verifyResult?.userInfo?.username === 'string'
        ? verifyResult.userInfo.username.trim()
        : '';
      const nextUsername = nextUsernameRaw || account.username || '';
      const inferredPlatformUserId = resolvePlatformUserId(account.extraConfig, nextUsername);
      const resolvedPlatformUserId = Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
        ? bodyPlatformUserId
        : inferredPlatformUserId;
      const nextApiToken = typeof verifyResult?.apiToken === 'string' && verifyResult.apiToken.trim().length > 0
        ? verifyResult.apiToken.trim()
        : (account.apiToken || '');

      const updates: Record<string, unknown> = {
        accessToken: nextAccessToken,
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      if (nextUsername) {
        updates.username = nextUsername;
      }
      if (nextApiToken) {
        updates.apiToken = nextApiToken;
      }
      if (resolvedPlatformUserId) {
        updates.extraConfig = mergeAccountExtraConfig(account.extraConfig, { platformUserId: resolvedPlatformUserId });
      }

      db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, accountId)).run();

      if (nextApiToken) {
        try {
          ensureDefaultTokenForAccount(accountId, nextApiToken, { name: 'default', source: 'sync' });
        } catch {}
      }

      try {
        await refreshBalance(accountId);
      } catch {}
      try {
        await refreshModelsForAccount(accountId);
        rebuildTokenRoutesFromAvailability();
      } catch {}

      const latest = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
      return {
        success: true,
        account: latest,
        apiTokenFound: !!nextApiToken,
      };
    },
  );

  // Add an account (manual token input) - auto-detects token type and fetches info
  app.post<{ Body: { siteId: number; username?: string; accessToken: string; apiToken?: string; platformUserId?: number; checkinEnabled?: boolean } }>('/api/accounts', async (request, reply) => {
    const body = request.body;
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, body.siteId)).get();
    if (!site) {
      return reply.code(400).send({ success: false, message: 'site not found' });
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply.code(400).send({ success: false, message: `platform not supported: ${site.platform}` });
    }

    let username = body.username;
    let accessToken = body.accessToken;
    let apiToken = body.apiToken;
    let verifyResult: any;
    try {
      verifyResult = await adapter.verifyToken(site.url, body.accessToken, body.platformUserId);
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
      });
    }
    const tokenType = verifyResult.tokenType;

    if (tokenType === 'unknown') {
      return reply.code(400).send({
        success: false,
        requiresVerification: true,
        message: 'Token 验证失败，请先点击“验证 Token”，验证成功后再绑定账号',
      });
    }

    if (tokenType === 'session') {
      // Token is a session cookie - can do management ops
      if (!username && verifyResult.userInfo?.username) username = verifyResult.userInfo.username;
      if (!apiToken && verifyResult.apiToken) apiToken = verifyResult.apiToken;
    } else if (tokenType === 'apikey') {
      // Token is an API key - store as apiToken, not accessToken
      apiToken = body.accessToken;
      accessToken = ''; // no session cookie available
    }

    // Store platformUserId in extraConfig for NewAPI sites that need it
    const resolvedPlatformUserId =
      body.platformUserId || guessPlatformUserIdFromUsername(username) || undefined;
    let extraConfig: string | undefined;
    if (resolvedPlatformUserId) {
      extraConfig = mergeAccountExtraConfig(undefined, { platformUserId: resolvedPlatformUserId });
    }

    const result = db.insert(schema.accounts).values({
      siteId: body.siteId,
      username: username || undefined,
      accessToken,
      apiToken: apiToken || undefined,
      checkinEnabled: tokenType === 'session' ? (body.checkinEnabled ?? true) : false,
      extraConfig,
      isPinned: false,
      sortOrder: getNextAccountSortOrder(),
    }).returning().get();

    if (apiToken) {
      try {
        ensureDefaultTokenForAccount(result.id, apiToken, { name: 'default', source: 'manual' });
      } catch { }
    }

    if (tokenType === 'session' && accessToken) {
      try {
        const syncedTokens = await adapter.getApiTokens(site.url, accessToken, resolvedPlatformUserId);
        if (syncedTokens.length > 0) {
          syncTokensFromUpstream(result.id, syncedTokens);
        }
      } catch { }
    }

    // Try to refresh balance
    if (tokenType === 'session') {
      try { await refreshBalance(result.id); } catch { }
    }
    try {
      await refreshModelsForAccount(result.id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, result.id)).get();
    return { ...account, tokenType, apiTokenFound: !!apiToken, usernameDetected: !!(!body.username && username) };
  });

  // Update an account
  app.put<{ Params: { id: string }; Body: any }>('/api/accounts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    const body = request.body as Record<string, unknown>;
    const updates: any = {};
    for (const key of ['username', 'accessToken', 'apiToken', 'status', 'checkinEnabled', 'unitCost', 'extraConfig']) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    if (body.isPinned !== undefined) {
      const normalizedPinned = normalizePinnedFlag(body.isPinned);
      if (normalizedPinned === null) {
        return reply.code(400).send({ message: 'Invalid isPinned value. Expected boolean.' });
      }
      updates.isPinned = normalizedPinned;
    }

    if (body.sortOrder !== undefined) {
      const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
      if (normalizedSortOrder === null) {
        return reply.code(400).send({ message: 'Invalid sortOrder value. Expected non-negative integer.' });
      }
      updates.sortOrder = normalizedSortOrder;
    }

    updates.updatedAt = new Date().toISOString();
    db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, id)).run();

    if (typeof updates.apiToken === 'string' && updates.apiToken.trim()) {
      try {
        ensureDefaultTokenForAccount(id, updates.apiToken, { name: 'default', source: 'manual' });
      } catch { }
    }

    try {
      await refreshModelsForAccount(id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    return db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  });

  // Delete an account
  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request) => {
    const id = parseInt(request.params.id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
    try {
      rebuildTokenRoutesFromAvailability();
    } catch { }
    return { success: true };
  });

  app.post<{ Body?: { accountId?: number; wait?: boolean } }>('/api/accounts/health/refresh', async (request, reply) => {
    const rawAccountId = request.body?.accountId as unknown;
    const hasAccountId = rawAccountId !== undefined && rawAccountId !== null && String(rawAccountId).trim() !== '';
    const accountId = hasAccountId ? Number.parseInt(String(rawAccountId), 10) : undefined;
    const wait = request.body?.wait === true;

    if (hasAccountId && (!Number.isFinite(accountId) || (accountId as number) <= 0)) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }

    if (wait) {
      const result = await executeRefreshAccountRuntimeHealth(accountId);
      if (accountId && result.summary.total === 0) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }
      return {
        success: true,
        ...result,
      };
    }

    const taskTitle = accountId ? `刷新账号运行健康状态 #${accountId}` : '刷新全部账号运行健康状态';
    const dedupeKey = accountId ? `refresh-account-runtime-health-${accountId}` : 'refresh-all-account-runtime-health';

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title: taskTitle,
        dedupeKey,
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: ReturnType<typeof summarizeAccountHealthRefresh> })?.summary;
          if (!summary) return `${taskTitle}已完成`;
          return `${taskTitle}完成：健康 ${summary.healthy}，异常 ${summary.unhealthy}，禁用 ${summary.disabled}`;
        },
        failureMessage: (currentTask) => `${taskTitle}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeRefreshAccountRuntimeHealth(accountId),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '账号运行健康状态刷新进行中，请稍后查看账号列表'
        : '已开始刷新账号运行健康状态，请稍后查看账号列表',
    });
  });

  // Refresh balance for an account
  app.post<{ Params: { id: string } }>('/api/accounts/:id/balance', async (request, reply) => {
    const id = parseInt(request.params.id);
    try {
      const result = await refreshBalance(id);
      if (!result) {
        reply.code(404);
        return { message: 'account not found or platform not supported' };
      }
      return result;
    } catch (err: any) {
      reply.code(400);
      return { message: err?.message || 'failed to fetch balance' };
    }
  });
}


