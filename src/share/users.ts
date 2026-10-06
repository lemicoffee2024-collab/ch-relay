// Allowlist of people who may use the public (share) endpoint with their own ChatGPT login.

import { getDb } from "../store/db.ts";

export interface ShareUser {
  email: string;
  label: string | null;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** When the user is removed automatically (epoch ms), counted from `createdAt`; null = never. */
  expiresAt: number | null;
}

interface Row {
  email: string;
  label: string | null;
  enabled: number;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(r: Row): ShareUser {
  return {
    email: r.email,
    label: r.label,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at ?? null,
  };
}

export function listShareUsers(): ShareUser[] {
  return (getDb().query("SELECT * FROM share_users ORDER BY created_at").all() as Row[]).map(toUser);
}

export function getShareUser(email: string): ShareUser | null {
  const r = getDb().query("SELECT * FROM share_users WHERE email = ?").get(normalizeEmail(email)) as Row | null;
  return r ? toUser(r) : null;
}

/** True once the operator has enrolled anyone — then only listed emails pass. */
export function shareAllowlistActive(): boolean {
  const r = getDb().query("SELECT 1 FROM share_users LIMIT 1").get();
  return r != null;
}

export const MAX_EXPIRE_HOURS = 24 * 365;

/** Validates an auto-removal window in whole hours (null = never). */
export function checkExpireHours(hours: unknown): number | null {
  if (hours === null || hours === undefined) return null;
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > MAX_EXPIRE_HOURS) throw new Error(`expire hours must be a whole number 1-${MAX_EXPIRE_HOURS}`);
  return h;
}

export function addShareUser(email: string, label?: string | null, expireHours?: number | null): ShareUser {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new Error(`invalid email: ${email}`);
  if (getShareUser(e)) throw new Error(`already added: ${e}`);
  const hours = checkExpireHours(expireHours);
  const now = Date.now();
  getDb()
    .query("INSERT INTO share_users(email, label, enabled, created_at, expires_at) VALUES (?, ?, 1, ?, ?)")
    .run(e, label?.trim() || null, now, hours === null ? null : now + hours * 3600_000);
  return getShareUser(e)!;
}

/** Remove the user `hours` after they were added (null = keep). A window already past removes them on the next sweep. */
export function setShareUserExpiry(email: string, hours: number | null): boolean {
  const h = checkExpireHours(hours);
  const e = normalizeEmail(email);
  const res =
    h === null
      ? getDb().query("UPDATE share_users SET expires_at = NULL WHERE email = ?").run(e)
      : getDb().query("UPDATE share_users SET expires_at = created_at + ? WHERE email = ?").run(h * 3600_000, e);
  return res.changes > 0;
}

export function isShareUserExpired(u: ShareUser, now = Date.now()): boolean {
  return u.expiresAt !== null && u.expiresAt <= now;
}

/** Delete users whose window has passed; returns their emails. */
export function purgeExpiredShareUsers(now = Date.now()): string[] {
  const rows = getDb().query("SELECT email FROM share_users WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<{ email: string }>;
  if (rows.length) getDb().query("DELETE FROM share_users WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
  return rows.map((r) => r.email);
}

export function removeShareUser(email: string): boolean {
  return getDb().query("DELETE FROM share_users WHERE email = ?").run(normalizeEmail(email)).changes > 0;
}

export function setShareUserEnabled(email: string, enabled: boolean): boolean {
  return getDb().query("UPDATE share_users SET enabled = ? WHERE email = ?").run(enabled ? 1 : 0, normalizeEmail(email)).changes > 0;
}

export function touchShareUser(email: string): void {
  getDb().query("UPDATE share_users SET last_seen_at = ? WHERE email = ?").run(Date.now(), normalizeEmail(email));
}

/** Usage-log account id for a share user. */
export function shareAccountId(email: string): string {
  return `share:${normalizeEmail(email)}`;
}
