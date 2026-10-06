import { Database } from "bun:sqlite";
import { DB_PATH, ensureHome } from "../paths.ts";
import { isEncrypted, protectText } from "../crypto/dpapi.ts";

let db: Database | null = null;
/** True once `useMemoryDb()` swapped in an in-memory database (tests): a worker could not see it. */
let inMemory = false;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  email TEXT,
  credential TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_provider ON accounts(provider);

-- Per-account, per-scope cooldown (scope = model family, or '*' for whole account).
CREATE TABLE IF NOT EXISTS cooldowns (
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  until INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (account_id, scope)
);

-- Latest known quota snapshot per account (provider specific JSON).
CREATE TABLE IF NOT EXISTS quota (
  account_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Conversation -> account binding so a thread stays on one account (prompt cache).
CREATE TABLE IF NOT EXISTS affinity (
  session_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, provider)
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  model TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  first_token_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  effort TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Opaque catalog alias -> real provider + upstream wire model (DPAPI-encrypted).
CREATE TABLE IF NOT EXISTS model_alias (
  alias TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  wire TEXT NOT NULL
);

-- People allowed to use the public share endpoint with their own ChatGPT login.
CREATE TABLE IF NOT EXISTS share_users (
  email TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  -- Auto-removal time (epoch ms); NULL = keep.
  expires_at INTEGER,
  -- Legacy enrollment key column; unused, kept for existing DBs.
  license_key TEXT
);

-- Admin console logins (username + argon2 hash) for the remote GUI port.
CREATE TABLE IF NOT EXISTS admin_users (
  username TEXT PRIMARY KEY,
  passhash TEXT NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Share-endpoint rejections worth a glance (rate limited, not on the allowlist). Verified
-- identities only, deduped per minute, purged after 30 days.
CREATE TABLE IF NOT EXISTS share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  email TEXT,
  ip_hash TEXT,
  detail TEXT,
  n INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS share_events_ts ON share_events(ts);

-- Last quota reading (x-codex-* headers) seen on each share user's own ChatGPT login.
CREATE TABLE IF NOT EXISTS share_quota (
  email TEXT PRIMARY KEY,
  short_percent REAL,
  short_reset_at INTEGER,
  weekly_percent REAL,
  weekly_reset_at INTEGER,
  plan TEXT,
  updated_at INTEGER NOT NULL
);

-- Append-only quota meter history: every x-codex-* reading on upstream responses
-- ('hdr') plus periodic WHAM /usage polls ('wham'). The empirical series for
-- answering "how much quota does one turn actually cost".
CREATE TABLE IF NOT EXISTS quota_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT,
  source TEXT NOT NULL,
  short_percent REAL,
  short_reset_at INTEGER,
  weekly_percent REAL,
  weekly_reset_at INTEGER,
  plan TEXT
);
CREATE INDEX IF NOT EXISTS quota_samples_ts ON quota_samples(ts);

-- Small TTL key/value cache (e.g. thought signatures).
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
);
`;

export function getDb(): Database {
  if (db) return db;
  ensureHome();
  db = new Database(process.env.CH_DB ?? DB_PATH, { create: true });
  db.exec(SCHEMA);
  migrateColumns(db);
  migrateSecrets(db);
  return db;
}

/** Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS won't add them). */
function migrateColumns(d: Database): void {
  const cols = new Set((d.query("PRAGMA table_info(share_users)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("expires_at")) d.exec("ALTER TABLE share_users ADD COLUMN expires_at INTEGER");
  if (!cols.has("license_key")) d.exec("ALTER TABLE share_users ADD COLUMN license_key TEXT");
  // Additive and nullable only (an older exe must still be able to open this file after a rollback).
  const usage = new Set((d.query("PRAGMA table_info(usage)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const col of ["client", "session_key", "ip_hash", "device"]) if (!usage.has(col)) d.exec(`ALTER TABLE usage ADD COLUMN ${col} TEXT`);
}

/** Encrypt sensitive columns written before DPAPI existed. */
function migrateSecrets(d: Database): void {
  const accs = d.query("SELECT id, credential FROM accounts").all() as Array<{ id: string; credential: string }>;
  const updAcc = d.query("UPDATE accounts SET credential = ? WHERE id = ?");
  for (const a of accs) if (!isEncrypted(a.credential)) updAcc.run(protectText(a.credential), a.id);
  const uses = d.query("SELECT id, model FROM usage").all() as Array<{ id: number; model: string }>;
  const updUse = d.query("UPDATE usage SET model = ? WHERE id = ?");
  for (const u of uses) if (!isEncrypted(u.model)) updUse.run(protectText(u.model), u.id);
  const quotas = d.query("SELECT account_id, data FROM quota").all() as Array<{ account_id: string; data: string }>;
  const updQ = d.query("UPDATE quota SET data = ? WHERE account_id = ?");
  for (const q of quotas) if (!isEncrypted(q.data)) updQ.run(protectText(q.data), q.account_id);
}

/** For tests: use an in-memory database. */
export function useMemoryDb(): Database {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  migrateColumns(db);
  inMemory = true;
  return db;
}

/** Path of the on-disk database in use, or null for an in-memory one. */
export function dbFilePath(): string | null {
  return inMemory ? null : (process.env.CH_DB ?? DB_PATH);
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .query("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export function kvGet(ns: string, key: string): string | null {
  const row = getDb()
    .query("SELECT value, expires_at FROM kv WHERE ns = ? AND key = ?")
    .get(ns, key) as { value: string; expires_at: number } | null;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().query("DELETE FROM kv WHERE ns = ? AND key = ?").run(ns, key);
    return null;
  }
  return row.value;
}

export function kvSet(ns: string, key: string, value: string, ttlMs: number): void {
  getDb()
    .query(
      "INSERT INTO kv(ns, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    )
    .run(ns, key, value, Date.now() + ttlMs);
}

export function kvDelete(ns: string, key: string): void {
  getDb().query("DELETE FROM kv WHERE ns = ? AND key = ?").run(ns, key);
}

export function kvPurgeExpired(): void {
  getDb().query("DELETE FROM kv WHERE expires_at < ?").run(Date.now());
}
