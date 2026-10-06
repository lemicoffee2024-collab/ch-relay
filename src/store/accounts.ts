import { getDb } from "./db.ts";
import { protectText, unprotectText } from "../crypto/dpapi.ts";
import type { Account, ProviderId } from "../types.ts";

interface Row {
  id: string;
  provider: string;
  label: string;
  email: string | null;
  credential: string;
  meta: string;
  priority: number;
  enabled: number;
  status: string;
  status_detail: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(r: Row): Account {
  return {
    id: r.id,
    provider: r.provider as ProviderId,
    label: r.label,
    email: r.email,
    credential: JSON.parse(unprotectText(r.credential)),
    meta: JSON.parse(r.meta),
    priority: r.priority,
    enabled: r.enabled === 1,
    status: r.status as Account["status"],
    statusDetail: r.status_detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listAccounts(provider?: ProviderId): Account[] {
  const rows = provider
    ? (getDb().query("SELECT * FROM accounts WHERE provider = ? ORDER BY priority DESC, created_at").all(provider) as Row[])
    : (getDb().query("SELECT * FROM accounts ORDER BY provider, priority DESC, created_at").all() as Row[]);
  return rows.map(fromRow);
}

export function getAccount(id: string): Account | null {
  const r = getDb().query("SELECT * FROM accounts WHERE id = ?").get(id) as Row | null;
  return r ? fromRow(r) : null;
}

export interface NewAccount {
  id?: string;
  provider: ProviderId;
  label: string;
  email?: string | null;
  credential: Record<string, unknown>;
  meta?: Record<string, unknown>;
  priority?: number;
}

/**
 * Insert an account, or update credential/meta of an existing one with the same
 * provider + dedupe key (email for OAuth providers). Returns the stored account.
 */
export function upsertAccount(a: NewAccount, dedupeKey?: { email?: string | null }): Account {
  const now = Date.now();
  if (dedupeKey?.email) {
    const existing = getDb()
      .query("SELECT id FROM accounts WHERE provider = ? AND lower(email) = lower(?)")
      .get(a.provider, dedupeKey.email) as { id: string } | null;
    if (existing) {
      getDb()
        .query(
          "UPDATE accounts SET credential = ?, meta = json_patch(meta, ?), status = 'ok', status_detail = NULL, updated_at = ? WHERE id = ?",
        )
        .run(protectText(JSON.stringify(a.credential)), JSON.stringify(a.meta ?? {}), now, existing.id);
      return getAccount(existing.id)!;
    }
  }
  const id = a.id ?? `${a.provider}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  getDb()
    .query(
      "INSERT INTO accounts(id, provider, label, email, credential, meta, priority, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'ok', ?, ?)",
    )
    .run(id, a.provider, a.label, a.email ?? null, protectText(JSON.stringify(a.credential)), JSON.stringify(a.meta ?? {}), a.priority ?? 0, now, now);
  return getAccount(id)!;
}

export function updateCredential(id: string, credential: Record<string, unknown>): void {
  getDb().query("UPDATE accounts SET credential = ?, updated_at = ? WHERE id = ?").run(protectText(JSON.stringify(credential)), Date.now(), id);
}

export function patchMeta(id: string, patch: Record<string, unknown>): void {
  getDb().query("UPDATE accounts SET meta = json_patch(meta, ?), updated_at = ? WHERE id = ?").run(JSON.stringify(patch), Date.now(), id);
}

export function setStatus(id: string, status: Account["status"], detail: string | null = null): void {
  getDb().query("UPDATE accounts SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?").run(status, detail, Date.now(), id);
}

export function updateAccountSettings(id: string, s: { label?: string; priority?: number; enabled?: boolean }): void {
  const cur = getAccount(id);
  if (!cur) return;
  getDb()
    .query("UPDATE accounts SET label = ?, priority = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(s.label ?? cur.label, s.priority ?? cur.priority, (s.enabled ?? cur.enabled) ? 1 : 0, Date.now(), id);
}

export function deleteAccount(id: string): void {
  const d = getDb();
  d.query("DELETE FROM accounts WHERE id = ?").run(id);
  d.query("DELETE FROM cooldowns WHERE account_id = ?").run(id);
  d.query("DELETE FROM quota WHERE account_id = ?").run(id);
  d.query("DELETE FROM affinity WHERE account_id = ?").run(id);
}

/** Public view of an account for the GUI (no secrets). */
export function publicAccount(a: Account) {
  const { credential: _c, ...rest } = a;
  return { ...rest, cooldowns: getCooldowns(a.id), quota: getQuota(a.id) };
}

// ---- cooldowns ----

export function setCooldown(accountId: string, scope: string, until: number, reason: string): void {
  getDb()
    .query(
      "INSERT INTO cooldowns(account_id, scope, until, reason) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, scope) DO UPDATE SET until = excluded.until, reason = excluded.reason",
    )
    .run(accountId, scope, until, reason);
}

export function clearCooldown(accountId: string, scope?: string): void {
  if (scope) getDb().query("DELETE FROM cooldowns WHERE account_id = ? AND scope = ?").run(accountId, scope);
  else getDb().query("DELETE FROM cooldowns WHERE account_id = ?").run(accountId);
}

export function getCooldowns(accountId: string): Array<{ scope: string; until: number; reason: string | null }> {
  return getDb()
    .query("SELECT scope, until, reason FROM cooldowns WHERE account_id = ? AND until > ?")
    .all(accountId, Date.now()) as Array<{ scope: string; until: number; reason: string | null }>;
}

export function isCooling(accountId: string, scope: string): boolean {
  const r = getDb()
    .query("SELECT 1 FROM cooldowns WHERE account_id = ? AND (scope = ? OR scope = '*') AND until > ?")
    .get(accountId, scope, Date.now());
  return r !== null;
}

// ---- quota ----

export function setQuota(accountId: string, data: Record<string, unknown>): void {
  getDb()
    .query(
      "INSERT INTO quota(account_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
    .run(accountId, protectText(JSON.stringify(data)), Date.now());
}

export function getQuota(accountId: string): (Record<string, unknown> & { updatedAt: number }) | null {
  const r = getDb().query("SELECT data, updated_at FROM quota WHERE account_id = ?").get(accountId) as
    | { data: string; updated_at: number }
    | null;
  return r ? { ...JSON.parse(unprotectText(r.data)), updatedAt: r.updated_at } : null;
}

// ---- affinity ----

const AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;

export function getAffinity(sessionKey: string, provider: ProviderId): string | null {
  const r = getDb()
    .query("SELECT account_id, updated_at FROM affinity WHERE session_key = ? AND provider = ?")
    .get(sessionKey, provider) as { account_id: string; updated_at: number } | null;
  if (!r || r.updated_at < Date.now() - AFFINITY_TTL_MS) return null;
  return r.account_id;
}

export function setAffinity(sessionKey: string, provider: ProviderId, accountId: string): void {
  getDb()
    .query(
      "INSERT INTO affinity(session_key, provider, account_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_key, provider) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at",
    )
    .run(sessionKey, provider, accountId, Date.now());
}

export function clearAffinityForAccount(accountId: string): void {
  getDb().query("DELETE FROM affinity WHERE account_id = ?").run(accountId);
}
