import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter downstream policy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-policy-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
  });

  beforeEach(() => {
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('respects allowedRouteIds when selecting channels', () => {
    const site = db.insert(schema.sites).values({
      name: 'site-a',
      url: 'https://a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-a',
      accessToken: 'access-a',
      apiToken: 'sk-a',
      status: 'active',
    }).returning().get();

    const routeAllowed = db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const routeBlocked = db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    db.insert(schema.routeChannels).values({
      routeId: routeAllowed.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    db.insert(schema.routeChannels).values({
      routeId: routeBlocked.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();

    const allowedPick = router.selectChannel('claude-opus-4-6', {
      allowedRouteIds: [routeAllowed.id],
      supportedModels: [],
      siteWeightMultipliers: {},
    });
    const blockedPick = router.selectChannel('gpt-4o-mini', {
      allowedRouteIds: [routeAllowed.id],
      supportedModels: [],
      siteWeightMultipliers: {},
    });

    expect(allowedPick).toBeTruthy();
    expect(allowedPick?.channel.routeId).toBe(routeAllowed.id);
    expect(blockedPick).toBeNull();
  });

  it('applies site weight multipliers to probability explanation', () => {
    const siteHigh = db.insert(schema.sites).values({
      name: 'high-site',
      url: 'https://high.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const siteLow = db.insert(schema.sites).values({
      name: 'low-site',
      url: 'https://low.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountHigh = db.insert(schema.accounts).values({
      siteId: siteHigh.id,
      username: 'user-high',
      accessToken: 'access-high',
      apiToken: 'sk-high',
      status: 'active',
      unitCost: 1,
      balance: 100,
    }).returning().get();

    const accountLow = db.insert(schema.accounts).values({
      siteId: siteLow.id,
      username: 'user-low',
      accessToken: 'access-low',
      apiToken: 'sk-low',
      status: 'active',
      unitCost: 1,
      balance: 100,
    }).returning().get();

    const route = db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-6',
      enabled: true,
    }).returning().get();

    const channelHigh = db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountHigh.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const channelLow = db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountLow.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const decision = router.explainSelectionForRoute(
      route.id,
      'claude-sonnet-4-6',
      [],
      {
        allowedRouteIds: [route.id],
        supportedModels: [],
        siteWeightMultipliers: {
          [siteHigh.id]: 4,
          [siteLow.id]: 1,
        },
      },
    );

    const highCandidate = decision.candidates.find((candidate) => candidate.channelId === channelHigh.id);
    const lowCandidate = decision.candidates.find((candidate) => candidate.channelId === channelLow.id);

    expect(highCandidate).toBeTruthy();
    expect(lowCandidate).toBeTruthy();
    expect((highCandidate?.probability || 0)).toBeGreaterThan(lowCandidate?.probability || 0);
  });

  it('supports union semantics between supportedModels and allowedRouteIds', () => {
    const site = db.insert(schema.sites).values({
      name: 'site-union',
      url: 'https://union.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-union',
      accessToken: 'access-union',
      apiToken: 'sk-union',
      status: 'active',
    }).returning().get();

    const claudeGroupRoute = db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      enabled: true,
    }).returning().get();

    const gptExactRoute = db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    db.insert(schema.routeChannels).values({
      routeId: claudeGroupRoute.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    db.insert(schema.routeChannels).values({
      routeId: gptExactRoute.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    const policy = {
      allowedRouteIds: [claudeGroupRoute.id],
      supportedModels: ['gpt-4o-mini'],
      siteWeightMultipliers: {},
    };

    const claudePick = router.selectChannel('claude-opus-4-6', policy);
    const gptPick = router.selectChannel('gpt-4o-mini', policy);

    expect(claudePick?.channel.routeId).toBe(claudeGroupRoute.id);
    expect(gptPick?.channel.routeId).toBe(gptExactRoute.id);
  });
});
