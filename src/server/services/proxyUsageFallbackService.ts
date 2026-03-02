import { fetch } from 'undici';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { withExplicitProxyRequestInit } from './siteProxy.js';

const SELF_LOG_FETCH_TIMEOUT_MS = 8_000;
const SELF_LOG_PAGE_SIZE = 20;
const MATCH_LOOKBACK_MS = 25_000;
const MATCH_LOOKAHEAD_MS = 120_000;
const MATCH_MAX_CREATED_DELTA_MS = 90_000;
const MATCH_MAX_LATENCY_DELTA_MS = 12_000;
const QUOTA_PER_UNIT = 500_000;
const SUPPORTED_USAGE_FALLBACK_PLATFORMS = new Set(['done-hub', 'one-hub', 'new-api', 'anyrouter']);
const ALWAYS_LOOKUP_SELF_LOG_PLATFORMS = new Set(['done-hub', 'one-hub']);
const PLATFORM_REQUIRES_USER_HEADER = new Set(['new-api', 'anyrouter']);

interface ProxyUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ProxyUsageFallbackInput {
  site: {
    url: string;
    platform: string;
    apiKey?: string | null;
    proxyUrl?: string | null;
  };
  account: {
    accessToken?: string | null;
    apiToken?: string | null;
    username?: string | null;
    extraConfig?: string | null;
    platformUserId?: number | null;
  };
  tokenValue?: string | null;
  tokenName?: string | null;
  modelName: string;
  requestStartedAtMs: number;
  requestEndedAtMs: number;
  localLatencyMs: number;
  usage: ProxyUsage;
}

interface ProxyUsageFallbackResult extends ProxyUsage {
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
}

export interface SelfLogItem {
  modelName: string;
  tokenName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  quota: number;
  createdAtMs: number;
  requestTimeMs: number;
}

interface SelfLogMatchInput {
  modelName: string;
  tokenName?: string | null;
  requestStartedAtMs: number;
  requestEndedAtMs: number;
  localLatencyMs: number;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function toTimestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.round(value);
    if (value > 1_000_000_000) return Math.round(value * 1000);
    return 0;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return toTimestampMs(numeric);
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function normalizeUsage(usage: ProxyUsage): ProxyUsage {
  const promptTokens = toPositiveInt(usage.promptTokens);
  const completionTokens = toPositiveInt(usage.completionTokens);
  const totalTokensRaw = toPositiveInt(usage.totalTokens);
  const totalTokens = totalTokensRaw > 0 ? totalTokensRaw : (promptTokens + completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function isUsageMissing(usage: ProxyUsage): boolean {
  return usage.promptTokens <= 0 && usage.completionTokens <= 0 && usage.totalTokens <= 0;
}

export function shouldLookupSelfLog(
  platform: string,
  usage: ProxyUsage,
): boolean {
  const normalizedPlatform = String(platform || '').toLowerCase();
  if (!SUPPORTED_USAGE_FALLBACK_PLATFORMS.has(normalizedPlatform)) return false;
  if (ALWAYS_LOOKUP_SELF_LOG_PLATFORMS.has(normalizedPlatform)) return true;
  return isUsageMissing(usage);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function getArrayNode(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.items)) return record.items;
  return null;
}

function modelNameMatches(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.endsWith(`/${normalizedRight}`)) return true;
  if (normalizedRight.endsWith(`/${normalizedLeft}`)) return true;

  const leftTail = normalizedLeft.split('/').pop() || '';
  const rightTail = normalizedRight.split('/').pop() || '';
  return !!leftTail && leftTail === rightTail;
}

function getPayloadList(payload: unknown): unknown[] {
  const candidates = [
    payload,
    (payload as any)?.data,
    (payload as any)?.data?.data,
    (payload as any)?.data?.items,
    (payload as any)?.items,
  ];

  for (const candidate of candidates) {
    const list = getArrayNode(candidate);
    if (list) return list;
  }

  return [];
}

function mapSelfLogItem(raw: unknown): SelfLogItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const modelName = String(row.model_name ?? row.modelName ?? '').trim();
  if (!modelName) return null;

  const promptTokens = toPositiveInt(row.prompt_tokens ?? row.promptTokens);
  const completionTokens = toPositiveInt(row.completion_tokens ?? row.completionTokens);
  const totalTokensRaw = toPositiveInt(row.total_tokens ?? row.totalTokens);
  const totalTokens = totalTokensRaw > 0 ? totalTokensRaw : (promptTokens + completionTokens);
  const createdAtMs = toTimestampMs(row.created_at ?? row.createdAt);
  if (createdAtMs <= 0) return null;

  return {
    modelName,
    tokenName: String(row.token_name ?? row.tokenName ?? '').trim(),
    promptTokens,
    completionTokens,
    totalTokens,
    quota: toPositiveInt(row.quota),
    createdAtMs,
    requestTimeMs: toPositiveInt(row.request_time ?? row.requestTime),
  };
}

function buildTokenCandidates(input: ProxyUsageFallbackInput): string[] {
  const candidates = [
    input.account.accessToken,
    input.tokenValue,
    input.account.apiToken,
    input.site.apiKey,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(candidates));
}

function resolveSelfLogUserId(input: ProxyUsageFallbackInput): number | undefined {
  const direct = toPositiveInt(input.account.platformUserId);
  if (direct > 0) return direct;
  return resolvePlatformUserId(input.account.extraConfig, input.account.username);
}

async function fetchSelfLogPayload(baseUrl: string, token: string, input: ProxyUsageFallbackInput): Promise<unknown> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, SELF_LOG_FETCH_TIMEOUT_MS);

  try {
    const query = `p=0&page=1&size=${SELF_LOG_PAGE_SIZE}&order=-created_at`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    const platform = String(input.site.platform || '').toLowerCase();
    if (PLATFORM_REQUIRES_USER_HEADER.has(platform)) {
      const userId = resolveSelfLogUserId(input);
      if (userId) {
        headers['New-Api-User'] = String(userId);
      }
    }
    const response = await fetch(`${baseUrl}/api/log/self?${query}`, withExplicitProxyRequestInit(input.site.proxyUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }));

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

async function fetchRecentSelfLogItems(input: ProxyUsageFallbackInput): Promise<SelfLogItem[]> {
  const baseUrl = normalizeUrl(input.site.url);
  const tokens = buildTokenCandidates(input);
  for (const token of tokens) {
    try {
      const payload = await fetchSelfLogPayload(baseUrl, token, input);
      const items = extractSelfLogItems(payload);
      if (items.length > 0) return items;
    } catch {}
  }
  return [];
}

export function extractSelfLogItems(payload: unknown): SelfLogItem[] {
  const rows = getPayloadList(payload);
  const items = rows
    .map((row) => mapSelfLogItem(row))
    .filter((item): item is SelfLogItem => item !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  return items;
}

export function findBestSelfLogMatch(items: SelfLogItem[], input: SelfLogMatchInput): SelfLogItem | null {
  const requestedModel = input.modelName.trim();
  if (!requestedModel || items.length === 0) return null;

  const windowStart = input.requestStartedAtMs - MATCH_LOOKBACK_MS;
  const windowEnd = input.requestEndedAtMs + MATCH_LOOKAHEAD_MS;
  let candidates = items.filter((item) => (
    modelNameMatches(item.modelName, requestedModel)
    && item.createdAtMs >= windowStart
    && item.createdAtMs <= windowEnd
    && (item.totalTokens > 0 || item.quota > 0 || item.requestTimeMs > 0)
  ));
  if (candidates.length === 0) return null;

  const tokenName = String(input.tokenName || '').trim().toLowerCase();
  if (tokenName) {
    const tokenMatched = candidates.filter((item) => item.tokenName.trim().toLowerCase() === tokenName);
    if (tokenMatched.length > 0) {
      candidates = tokenMatched;
    }
  }

  let best: SelfLogItem | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const createdAtDelta = Math.abs(candidate.createdAtMs - input.requestEndedAtMs);
    const latencyDelta = (input.localLatencyMs > 0 && candidate.requestTimeMs > 0)
      ? Math.abs(candidate.requestTimeMs - input.localLatencyMs)
      : 0;
    const score = createdAtDelta + (latencyDelta * 2);

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best) return null;

  const createdDelta = Math.abs(best.createdAtMs - input.requestEndedAtMs);
  if (createdDelta > MATCH_MAX_CREATED_DELTA_MS) return null;

  if (input.localLatencyMs > 0 && best.requestTimeMs > 0) {
    const latencyDelta = Math.abs(best.requestTimeMs - input.localLatencyMs);
    if (latencyDelta > MATCH_MAX_LATENCY_DELTA_MS) return null;
  }

  return best;
}

function toQuotaCost(quota: number): number {
  return roundCost(toPositiveInt(quota) / QUOTA_PER_UNIT);
}

export async function resolveProxyUsageWithSelfLogFallback(
  input: ProxyUsageFallbackInput,
): Promise<ProxyUsageFallbackResult> {
  const normalizedUsage = normalizeUsage(input.usage);
  const fallback: ProxyUsageFallbackResult = {
    ...normalizedUsage,
    recoveredFromSelfLog: false,
    estimatedCostFromQuota: 0,
  };

  const platform = String(input.site.platform || '').toLowerCase();
  if (!shouldLookupSelfLog(platform, normalizedUsage)) {
    return fallback;
  }

  try {
    const items = await fetchRecentSelfLogItems(input);
    const matched = findBestSelfLogMatch(items, {
      modelName: input.modelName,
      tokenName: input.tokenName,
      requestStartedAtMs: input.requestStartedAtMs,
      requestEndedAtMs: input.requestEndedAtMs,
      localLatencyMs: input.localLatencyMs,
    });

    if (!matched) return fallback;

    const matchedUsage: ProxyUsage = {
      promptTokens: matched.promptTokens,
      completionTokens: matched.completionTokens,
      totalTokens: matched.totalTokens,
    };
    const normalizedMatched = normalizeUsage(matchedUsage);
    const useMatchedTokens = normalizedMatched.totalTokens > 0
      || normalizedMatched.promptTokens > 0
      || normalizedMatched.completionTokens > 0;
    const resolvedTokens = useMatchedTokens ? normalizedMatched : normalizedUsage;

    return {
      promptTokens: resolvedTokens.promptTokens,
      completionTokens: resolvedTokens.completionTokens,
      totalTokens: resolvedTokens.totalTokens,
      recoveredFromSelfLog: true,
      estimatedCostFromQuota: toQuotaCost(matched.quota),
    };
  } catch {
    return fallback;
  }
}
