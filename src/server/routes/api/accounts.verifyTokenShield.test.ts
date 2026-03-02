import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifyTokenMock = vi.fn();
const undiciFetchMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts verify-token shield detection', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-verify-shield-'));
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
    undiciFetchMock.mockReset();

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

  it('returns rebind hint when verify-token reports invalid access token', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('invalid access token'));

    const site = db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'invalid access token，请在中转站重新生成系统访问令牌后重新绑定账号',
    });
  });

  it('returns shieldBlocked when upstream /api/user/self responds with challenge html', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({
      text: async () => '<html><script>var arg1="ABC123";</script></html>',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      },
    });

    const site = db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      shieldBlocked: true,
    });
    expect(undiciFetchMock).toHaveBeenCalled();
  });
});
