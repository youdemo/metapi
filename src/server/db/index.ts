import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { config } from '../config.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const dbPath = `${config.dataDir}/hub.db`;
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

function tableExists(table: string): boolean {
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

function tableColumnExists(table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function ensureTokenManagementSchema() {
  if (!tableExists('accounts') || !tableExists('route_channels')) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      account_id integer NOT NULL,
      name text NOT NULL,
      token text NOT NULL,
      source text DEFAULT 'manual',
      enabled integer DEFAULT true,
      is_default integer DEFAULT false,
      created_at text DEFAULT (datetime('now')),
      updated_at text DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE cascade
    );
  `);

  if (!tableColumnExists('route_channels', 'token_id')) {
    sqlite.exec('ALTER TABLE route_channels ADD COLUMN token_id integer;');
  }

  sqlite.exec(`
    INSERT INTO account_tokens (account_id, name, token, source, enabled, is_default, created_at, updated_at)
    SELECT
      a.id,
      'default',
      a.api_token,
      'legacy',
      true,
      true,
      datetime('now'),
      datetime('now')
    FROM accounts AS a
    WHERE
      a.api_token IS NOT NULL
      AND trim(a.api_token) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM account_tokens AS t
        WHERE t.account_id = a.id
        AND t.token = a.api_token
      );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS token_model_availability (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      token_id integer NOT NULL,
      model_name text NOT NULL,
      available integer,
      latency_ms integer,
      checked_at text DEFAULT (datetime('now')),
      FOREIGN KEY (token_id) REFERENCES account_tokens(id) ON DELETE cascade
    );
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS token_model_availability_token_model_unique
    ON token_model_availability(token_id, model_name);
  `);
}

function ensureSiteStatusSchema() {
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'status')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN status text DEFAULT 'active';`);
  }

  sqlite.exec(`
    UPDATE sites
    SET status = lower(trim(status))
    WHERE status IS NOT NULL
      AND lower(trim(status)) IN ('active', 'disabled')
      AND status != lower(trim(status));
  `);

  sqlite.exec(`
    UPDATE sites
    SET status = 'active'
    WHERE status IS NULL
      OR trim(status) = ''
      OR lower(trim(status)) NOT IN ('active', 'disabled');
  `);
}

function ensureSiteProxySchema() {
  if (!tableExists('sites')) {
    return;
  }

  if (!tableColumnExists('sites', 'proxy_url')) {
    sqlite.exec(`ALTER TABLE sites ADD COLUMN proxy_url text;`);
  }
}

function ensureRouteGroupingSchema() {
  if (!tableExists('token_routes') || !tableExists('route_channels')) {
    return;
  }

  if (!tableColumnExists('token_routes', 'display_name')) {
    sqlite.exec(`ALTER TABLE token_routes ADD COLUMN display_name text;`);
  }

  if (!tableColumnExists('token_routes', 'display_icon')) {
    sqlite.exec(`ALTER TABLE token_routes ADD COLUMN display_icon text;`);
  }

  if (!tableColumnExists('route_channels', 'source_model')) {
    sqlite.exec(`ALTER TABLE route_channels ADD COLUMN source_model text;`);
  }
}

function ensureDownstreamApiKeySchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS downstream_api_keys (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      name text NOT NULL,
      key text NOT NULL,
      description text,
      enabled integer DEFAULT true,
      expires_at text,
      max_cost real,
      used_cost real DEFAULT 0,
      max_requests integer,
      used_requests integer DEFAULT 0,
      supported_models text,
      allowed_route_ids text,
      site_weight_multipliers text,
      last_used_at text,
      created_at text DEFAULT (datetime('now')),
      updated_at text DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS downstream_api_keys_key_unique
    ON downstream_api_keys(key);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_name_idx
    ON downstream_api_keys(name);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_enabled_idx
    ON downstream_api_keys(enabled);
  `);
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS downstream_api_keys_expires_at_idx
    ON downstream_api_keys(expires_at);
  `);
}

ensureTokenManagementSchema();
ensureSiteStatusSchema();
ensureSiteProxySchema();
ensureRouteGroupingSchema();
ensureDownstreamApiKeySchema();

export const db = drizzle(sqlite, { schema });
export { schema };
