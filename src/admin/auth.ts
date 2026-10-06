// Admin console auth: local username/password accounts + cookie sessions.
// Passwords hashed with argon2id (Bun.password). Sessions live in the kv table
// (ns "admin"), so they expire with the periodic kvPurgeExpired sweep.

import { getDb, kvDelete, kvGet, kvSet } from "../store/db.ts";

export const ADMIN_COOKIE = "ch_admin";
const SESSION_TTL_MS = 30 * 86400_000;
const NS = "admin";

export interface AdminUser {
  username: string;
  label: string | null;
  enabled: boolean;
  createdAt: number;
}

interface Row {
  username: string;
  passhash: string;
  label: string | null;
  enabled: number;
  created_at: number;
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

const row = (username: string): Row | null =>
  getDb().query("SELECT * FROM admin_users WHERE username = ?").get(username) as Row | null;

const toPublic = (r: Row): AdminUser => ({ username: r.username, label: r.label, enabled: !!r.enabled, createdAt: r.created_at });

export async function addAdminUser(username: string, password: string, label?: string | null): Promise<AdminUser> {
  username = username.trim();
  if (!USERNAME_RE.test(username)) throw new Error("username must be 3-32 chars of [a-z 0-9 . _ -]");
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  if (row(username)) throw new Error(`admin user ${username} already exists`);
  const passhash = await Bun.password.hash(password);
  getDb()
    .query("INSERT INTO admin_users(username, passhash, label, created_at) VALUES (?, ?, ?, ?)")
    .run(username, passhash, label ?? null, Date.now());
  return toPublic(row(username)!);
}

export function listAdminUsers(): AdminUser[] {
  return (getDb().query("SELECT * FROM admin_users ORDER BY created_at").all() as Row[]).map(toPublic);
}

export function removeAdminUser(username: string): boolean {
  return getDb().query("DELETE FROM admin_users WHERE username = ?").run(username).changes > 0;
}

export async function setAdminPassword(username: string, password: string): Promise<boolean> {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const passhash = await Bun.password.hash(password);
  return getDb().query("UPDATE admin_users SET passhash = ? WHERE username = ?").run(passhash, username).changes > 0;
}

export async function verifyAdmin(username: string, password: string): Promise<boolean> {
  const r = row(username.trim());
  if (!r || !r.enabled) return false;
  return Bun.password.verify(password, r.passhash);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function createSession(username: string): string {
  const token = newToken();
  kvSet(NS, `sess.${token}`, username, SESSION_TTL_MS);
  return token;
}

export function sessionTokenFrom(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === ADMIN_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** Username for a valid session, or null. Disabled/deleted users lose access immediately. */
export function sessionUser(req: Request): string | null {
  const token = sessionTokenFrom(req);
  if (!token) return null;
  const username = kvGet(NS, `sess.${token}`);
  if (!username) return null;
  const r = row(username);
  return r && r.enabled ? username : null;
}

export function destroySession(token: string): void {
  kvDelete(NS, `sess.${token}`);
}

export function sessionCookie(req: Request, token: string): string {
  const secure = req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearSessionCookie(): string {
  return `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// login rate limit (per client IP, in-memory)
// ---------------------------------------------------------------------------

const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
const fails = new Map<string, { n: number; until: number }>();

export function loginLocked(ip: string): boolean {
  const f = fails.get(ip);
  if (!f) return false;
  if (f.until > Date.now()) return true;
  if (f.until) fails.delete(ip);
  return false;
}

export function loginFailed(ip: string): void {
  const f = fails.get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) {
    f.until = Date.now() + LOCK_MS;
    f.n = 0;
  }
  fails.set(ip, f);
}

export function loginSucceeded(ip: string): void {
  fails.delete(ip);
}
