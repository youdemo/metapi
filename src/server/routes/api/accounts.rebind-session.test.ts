import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const verifyTokenMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts rebind-session api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-rebind-session-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(() => {
    verifyTokenMock.mockReset();

    db.delete(schema.proxyLogs).run();
    db.delete(schema.checkinLogs).run();
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects rebinding when token is not verified as session', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const site = db.insert(schema.sites).values({
      name: 'Rebind Site',
      url: 'https://rebind.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_1001',
      accessToken: 'old-access-token',
      status: 'expired',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/rebind-session`,
      payload: {
        accessToken: 'new-access-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
    });

    const latest = db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(latest?.accessToken).toBe('old-access-token');
    expect(latest?.status).toBe('expired');
  });

  it('returns rebind hint when verify reports invalid access token', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('无权进行此操作，access token 无效'));

    const site = db.insert(schema.sites).values({
      name: 'Rebind Site',
      url: 'https://rebind.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_1001',
      accessToken: 'old-access-token',
      status: 'expired',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/rebind-session`,
      payload: {
        accessToken: 'new-access-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '无权进行此操作，access token 无效，请在中转站重新生成系统访问令牌后重新绑定账号',
    });
  });

  it('reactivates expired account when session token verification succeeds', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'session',
      userInfo: { username: 'linuxdo_1002' },
      apiToken: 'sk-rebound-token',
    });

    const site = db.insert(schema.sites).values({
      name: 'Rebind Site',
      url: 'https://rebind.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_1001',
      accessToken: 'old-access-token',
      status: 'expired',
      extraConfig: JSON.stringify({ platformUserId: 1001 }),
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/rebind-session`,
      payload: {
        accessToken: 'new-session-token',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success?: boolean; apiTokenFound?: boolean };
    expect(body.success).toBe(true);
    expect(body.apiTokenFound).toBe(true);

    const latest = db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(latest?.accessToken).toBe('new-session-token');
    expect(latest?.apiToken).toBe('sk-rebound-token');
    expect(latest?.username).toBe('linuxdo_1002');
    expect(latest?.status).toBe('active');
  });
});
