import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./downstreamApiKeyService.js');
type ConfigModule = typeof import('../config.js');

describe('downstreamApiKeyService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-key-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./downstreamApiKeyService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    service = serviceModule;
  });

  beforeEach(() => {
    db.delete(schema.downstreamApiKeys).run();
    db.delete(schema.tokenRoutes).run();
    config.proxyToken = 'sk-global-proxy-token';
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('authorizes global proxy token when no managed key matches', () => {
    const result = service.authorizeDownstreamToken('sk-global-proxy-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBeNull();
      expect(result.policy.allowedRouteIds).toEqual([]);
      expect(result.policy.supportedModels).toEqual([]);
    }
  });

  it('rejects managed keys by lifecycle guards (disabled, expired, over budget, over requests)', () => {
    const now = Date.now();

    const disabled = db.insert(schema.downstreamApiKeys).values({
      name: 'disabled',
      key: 'sk-disabled',
      enabled: false,
    }).returning().get();

    const expired = db.insert(schema.downstreamApiKeys).values({
      name: 'expired',
      key: 'sk-expired',
      enabled: true,
      expiresAt: new Date(now - 60_000).toISOString(),
    }).returning().get();

    const overBudget = db.insert(schema.downstreamApiKeys).values({
      name: 'over-budget',
      key: 'sk-over-budget',
      enabled: true,
      maxCost: 1,
      usedCost: 1.2,
    }).returning().get();

    const overRequests = db.insert(schema.downstreamApiKeys).values({
      name: 'over-requests',
      key: 'sk-over-requests',
      enabled: true,
      maxRequests: 10,
      usedRequests: 10,
    }).returning().get();

    const r1 = service.authorizeDownstreamToken(disabled.key);
    const r2 = service.authorizeDownstreamToken(expired.key);
    const r3 = service.authorizeDownstreamToken(overBudget.key);
    const r4 = service.authorizeDownstreamToken(overRequests.key);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(r4.ok).toBe(false);
  });

  it('parses policy fields and supports model matching patterns', () => {
    const row = db.insert(schema.downstreamApiKeys).values({
      name: 'project-a',
      key: 'sk-project-a',
      enabled: true,
      supportedModels: JSON.stringify(['re:^claude-(opus|sonnet)-4-6$', 'gpt-4o-mini']),
      allowedRouteIds: JSON.stringify([101, 102]),
      siteWeightMultipliers: JSON.stringify({ '1': 2.5, '7': 0.4 }),
    }).returning().get();

    const result = service.authorizeDownstreamToken(row.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.key?.id).toBe(row.id);
    expect(result.policy.allowedRouteIds).toEqual([101, 102]);
    expect(result.policy.siteWeightMultipliers[1]).toBeCloseTo(2.5);
    expect(result.policy.siteWeightMultipliers[7]).toBeCloseTo(0.4);

    expect(service.isModelAllowedByPolicy('claude-opus-4-6', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gpt-4o-mini', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gemini-2.0-flash', result.policy)).toBe(false);
  });

  it('treats selected groups as additional allowed model scope (union semantics)', () => {
    const claudeGroup = db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: ['gpt-4o-mini'],
      allowedRouteIds: [claudeGroup.id],
      siteWeightMultipliers: {},
    };

    expect(service.isModelAllowedByPolicy('claude-opus-4-6', policy)).toBe(false);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('gemini-2.0-flash', policy)).toBe(false);
  });

  it('authorizes by selected group model pattern only, not arbitrary internal models', () => {
    const virtualModelGroup = db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [virtualModelGroup.id],
      siteWeightMultipliers: {},
    };

    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-6', policy)).toBe(false);
  });

  it('authorizes models by selected route display name alias', () => {
    const aliasRoute = db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-5$',
      displayName: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [aliasRoute.id],
      siteWeightMultipliers: {},
    };

    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-5', policy)).toBe(true);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-5', policy)).toBe(true);
    expect(service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
  });
});
