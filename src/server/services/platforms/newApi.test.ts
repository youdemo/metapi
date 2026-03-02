import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { NewApiAdapter } from './newApi.js';

interface RequestSnapshot {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const COOKIE_SESSION_TOKEN = 'cookie-session-token';
const COOKIE_REQUIRES_USER_TOKEN = 'cookie-requires-user';
const CHECKIN_ALREADY_TOKEN = 'checkin-already-token';
const CHECKIN_INVALID_URL_TOKEN = 'checkin-invalid-url-token';
const CHECKIN_CLOUDFLARE_530_TOKEN = 'checkin-cloudflare-530-token';
const BALANCE_FAIL_TOKEN = 'balance-fail-token';
const COOKIE_SHIELDED_TOKEN = Buffer.from(
  `1771864970|${Buffer.from('username=linuxdo_131936').toString('base64')}|sig`,
).toString('base64');
const ANYROUTER_CHALLENGE_HTML = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const ANYROUTER_CHALLENGE_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const CLOUDFLARE_530_HTML = `
<!doctype html>
<html lang="en-US">
  <head>
    <title>Cloudflare Tunnel error | newapi.tanmw.top | Cloudflare</title>
  </head>
  <body>
    <h1><span>Error</span><span>1033</span></h1>
    <h2>Cloudflare Tunnel error</h2>
  </body>
</html>
`;

describe('NewApiAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requests: RequestSnapshot[] = [];

  beforeEach(async () => {
    requests = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid token' } }));
        return;
      }

      if (req.url === '/api/user/models') {
        if (req.headers['new-api-user'] !== '11494') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ['gpt-4o', 'gpt-4.1'] }));
        return;
      }

      if (req.url?.startsWith('/api/token/')) {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'shielded-cookie-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-api-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-user-key' }],
            },
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            items: [{ key: 'api-key-from-token-list' }],
          },
        }));
        return;
      }

      if (req.url === '/api/user/self') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_FAIL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '閺冪姵娼堟潻娑滎攽濮濄倖鎼锋担婊愮礉閺堫亞娅ヨぐ鏇氱瑬閺堫亝褰佹笟?access token' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_FAIL_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_FAIL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '閺冪姵娼堟潻娑滎攽濮濄倖鎼锋担婊愮礉閺堫亞娅ヨぐ鏇氱瑬閺堫亝褰佹笟?access token' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 131936, username: 'linuxdo_131936', quota: 3000000, used_quota: 1200000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 11494, username: 'demo-user', quota: 1000000, used_quota: 1000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 7788, username: 'cookie-user', quota: 2000000, used_quota: 500000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 8899, username: 'cookie-user-id-required', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
        return;
      }

      if (req.url === '/api/user/checkin') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_CLOUDFLARE_530_TOKEN}`) {
          res.writeHead(530, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CLOUDFLARE_530_HTML);
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '浠婂ぉ宸茬粡绛惧埌杩囧暒' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '鏃犳潈杩涜姝ゆ搷浣滐紝鏈櫥褰曚笖鏈彁渚?access token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-ok' }));
          return;
        }
      }

      if (req.url === '/api/user/sign_in') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '鏃犳潈杩涜姝ゆ搷浣滐紝鏈櫥褰曚笖鏈彁渚?access token' }));
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('falls back to session model endpoint when /v1/models rejects token', async () => {
    const adapter = new NewApiAdapter();
    const models = await adapter.getModels(baseUrl, 'session-token', 11494);

    expect(models).toEqual(['gpt-4o', 'gpt-4.1']);
    expect(requests.some((r) => r.url === '/v1/models')).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/models' && r.headers['new-api-user'] === '11494'),
    ).toBe(true);
  });

  it('parses token list response with data.items[] shape', async () => {
    const adapter = new NewApiAdapter();
    const token = await adapter.getApiToken(baseUrl, 'session-token', 11494);

    expect(token).toBe('api-key-from-token-list');
  });

  it('detects cookie session values as session cookies for anyrouter-like deployments', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user');
    expect(result.apiToken).toBe('cookie-api-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && typeof r.headers.cookie === 'string' && r.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)),
    ).toBe(true);
  });

  it('auto-probes New-Api-User for cookie sessions when header is required', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_USER_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user-id-required');
    expect(result.apiToken).toBe('cookie-user-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '8899'),
    ).toBe(true);
  });

  it('solves anyrouter acw challenge and probes user id from session payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_131936');
    expect(typeof result.apiToken === 'string' && result.apiToken.length > 0).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/self' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('uses shielded cookie flow for balance and checkin', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_SHIELDED_TOKEN);
    const checkin = await adapter.checkin(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(balance).toEqual({
      quota: 8.4,
      used: 2.4,
      balance: 6,
    });
    expect(checkin.success).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/checkin' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('preserves upstream balance failure message for UI feedback', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_FAIL_TOKEN)).rejects.toThrow('access token');
  });

  it('preserves nested checkin error message instead of generic fallback', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid URL');
  });

  it('summarizes cloudflare tunnel HTML failures to concise checkin error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_CLOUDFLARE_530_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 530: Cloudflare Tunnel error (Error 1033)');
  });

  it('preserves already-checked-in message instead of overriding with cookie fallback error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('浠婂ぉ宸茬粡绛惧埌杩囧暒');
  });
});
