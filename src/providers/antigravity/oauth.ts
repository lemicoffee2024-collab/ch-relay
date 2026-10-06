// Google OAuth (PKCE) login, token refresh and Cloud Code Assist project discovery.
import { createHash, randomBytes } from "node:crypto";
import { getAccount, listAccounts, patchMeta, setStatus, updateCredential, upsertAccount } from "../../store/accounts.ts";
import { log } from "../../lib/log.ts";
import type { Account, LoginFlow, LoginStart, LoginStatus } from "../../types.ts";
import {
  AUTH_ENDPOINT,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CLIENT_ID,
  DAILY_API,
  IDE_VERSION,
  PROD_API,
  REDIRECT_URI,
  SCOPES,
  TOKEN_ENDPOINT,
  USERINFO_ENDPOINT,
  antigravityUserAgent,
  apiUrl,
} from "./constants.ts";
import { requireClientSecret } from "./secret.ts";

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;

export interface AgyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the refresh token itself was rejected (re-login required). */
    readonly invalidGrant: boolean,
  ) {
    super(message);
  }
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function jwtEmail(token: string | undefined): string | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const email = JSON.parse(Buffer.from(part, "base64url").toString("utf8")).email;
    return typeof email === "string" && email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

interface TokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function postToken(form: Record<string, string>, signal?: AbortSignal): Promise<TokenPayload> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: timeoutSignal(signal),
  });
  if (!res.ok) {
    // Only the OAuth error code is surfaced: the body can carry account details.
    let code = "";
    try {
      code = String(((await res.json()) as { error?: unknown }).error ?? "");
    } catch {
      /* ignore */
    }
    throw new TokenError(`Antigravity token request failed: ${res.status}${code ? ` ${code}` : ""}`, res.status, code === "invalid_grant");
  }
  return (await res.json()) as TokenPayload;
}

function credentialFrom(p: TokenPayload, refreshFallback = ""): AgyCredential & { email: string | null } {
  if (!p.access_token) throw new Error("Antigravity token response did not include an access token");
  const refresh = p.refresh_token || refreshFallback;
  if (!refresh) throw new Error("Antigravity token response did not include a refresh token");
  const expiresIn = typeof p.expires_in === "number" && Number.isFinite(p.expires_in) ? p.expires_in : 3600;
  return {
    accessToken: p.access_token,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    email: jwtEmail(p.id_token) ?? jwtEmail(p.access_token),
  };
}

/** Google refresh tokens do not rotate: keep the old one when the response omits it. */
export async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<AgyCredential> {
  const p = await postToken(
    { grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: requireClientSecret(), refresh_token: refreshToken },
    signal,
  );
  const { email: _e, ...cred } = credentialFrom(p, refreshToken);
  return cred;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

export function extractProjectId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && (v as { id: string }).id) {
      return (v as { id: string }).id;
    }
  }
  return undefined;
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "*/*",
    "Content-Type": "application/json",
    "User-Agent": antigravityUserAgent(),
  };
}

export async function discoverProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(apiUrl(PROD_API, "loadCodeAssist"), {
      method: "POST",
      headers: apiHeaders(accessToken),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: timeoutSignal(signal),
    });
    if (res.ok) {
      const id = extractProjectId(await res.json().catch(() => undefined));
      if (id) return id;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error("Antigravity onboarding aborted");
    const res = await fetch(apiUrl(DAILY_API, "onboardUser"), {
      method: "POST",
      headers: apiHeaders(accessToken),
      body: JSON.stringify({
        tier_id: "free-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: IDE_VERSION },
      }),
      signal: timeoutSignal(signal),
    });
    if (!res.ok) {
      if (res.status !== 429 && res.status < 500) return undefined;
    } else {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.done === true) return extractProjectId(data.response);
    }
    await Bun.sleep(ONBOARD_POLL_MS);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Access tokens for requests
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<AgyCredential>>();

function storedCredential(a: Account): AgyCredential {
  return {
    accessToken: String(a.credential.accessToken ?? ""),
    refreshToken: String(a.credential.refreshToken ?? ""),
    expiresAt: Number(a.credential.expiresAt ?? 0),
  };
}

/** Refresh (deduped per account) and persist the new credential. */
export function forceRefresh(account: Account, signal?: AbortSignal): Promise<AgyCredential> {
  const existing = inflight.get(account.id);
  if (existing) return existing;
  const p = (async () => {
    const cur = storedCredential(getAccount(account.id) ?? account);
    if (!cur.refreshToken) throw new TokenError("Antigravity account has no refresh token", 401, true);
    try {
      const next = await refreshAccessToken(cur.refreshToken, signal);
      updateCredential(account.id, { ...(getAccount(account.id)?.credential ?? {}), ...next });
      return next;
    } catch (err) {
      if (err instanceof TokenError && err.invalidGrant) setStatus(account.id, "needs_reauth", "refresh token rejected (invalid_grant)");
      throw err;
    }
  })().finally(() => inflight.delete(account.id));
  inflight.set(account.id, p);
  return p;
}

/** Access token valid for at least 5 more minutes (proactive refresh). */
export async function getAccessToken(account: Account, signal?: AbortSignal): Promise<string> {
  const cur = storedCredential(getAccount(account.id) ?? account);
  if (cur.accessToken && cur.expiresAt > Date.now() + REFRESH_SKEW_MS) return cur.accessToken;
  return (await forceRefresh(account, signal)).accessToken;
}

/** Project id for an account, discovering (and persisting) it when missing. */
export async function getProjectId(account: Account, accessToken: string, signal?: AbortSignal): Promise<string> {
  const existing = (getAccount(account.id) ?? account).meta.projectId;
  if (typeof existing === "string" && existing) return existing;
  const id = await discoverProject(accessToken, signal);
  if (!id) throw new Error("no Cloud Code Assist project for this Antigravity account");
  patchMeta(account.id, { projectId: id });
  return id;
}

// ---------------------------------------------------------------------------
// Login flow (auth code + PKCE, loopback callback server)
// ---------------------------------------------------------------------------

interface PendingLogin {
  status: LoginStatus;
  state: string;
  verifier: string;
  server: ReturnType<typeof Bun.serve> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const logins = new Map<string, PendingLogin>();

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function page(title: string, body: string, ok: boolean): Response {
  const color = ok ? "#1d9b50" : "#c62828";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border-radius:18px;padding:40px 48px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;max-width:420px}
h1{font-size:22px;margin:0 0 8px;color:${color}}p{margin:0;color:#6e6e73;font-size:15px}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function stopLogin(p: PendingLogin): void {
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  const server = p.server;
  p.server = null;
  // Let the success page flush before closing the listener.
  if (server) setTimeout(() => server.stop(true), 250);
}

async function completeLogin(p: PendingLogin, code: string): Promise<{ accountId: string; email: string | null }> {
  const payload = await postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: requireClientSecret(),
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: p.verifier,
  });
  const cred = credentialFrom(payload);
  let email = cred.email;
  if (!email) {
    const r = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${cred.accessToken}` }, signal: timeoutSignal() });
    if (r.ok) email = (((await r.json()) as { email?: string }).email ?? null)?.toLowerCase() ?? null;
  }
  const projectId = await discoverProject(cred.accessToken);
  if (!projectId) throw new Error("could not discover a Cloud Code Assist project for this Google account");
  const acc = upsertAccount(
    {
      provider: "antigravity",
      label: email ?? "antigravity",
      email,
      credential: { accessToken: cred.accessToken, refreshToken: cred.refreshToken, expiresAt: cred.expiresAt },
      meta: { projectId },
    },
    { email },
  );
  return { accountId: acc.id, email };
}

export const antigravityLogin: LoginFlow = {
  async start(): Promise<LoginStart> {
    requireClientSecret();
    // Only one loopback listener can own the fixed port.
    for (const [id, p] of logins) if (p.status.state === "pending") antigravityLogin.cancel(id);

    const loginId = crypto.randomUUID();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(24));
    const pending: PendingLogin = { status: { state: "pending" }, state, verifier, server: null, timer: null };

    pending.server = Bun.serve({
      hostname: CALLBACK_HOST,
      port: CALLBACK_PORT,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
        if (pending.status.state !== "pending") return page("Already handled", "You can close this window.", pending.status.state === "done");
        const err = url.searchParams.get("error");
        if (err) {
          pending.status = { state: "error", message: `Google returned: ${err}` };
          stopLogin(pending);
          return page("Sign-in cancelled", escapeHtml(err), false);
        }
        if (url.searchParams.get("state") !== state) return page("Invalid request", "State mismatch. Start the login again.", false);
        const code = url.searchParams.get("code");
        if (!code) return page("Invalid request", "Missing authorization code.", false);
        try {
          const done = await completeLogin(pending, code);
          pending.status = { state: "done", accountId: done.accountId, email: done.email };
          log.info(`antigravity login ok (${done.email ?? done.accountId})`);
          stopLogin(pending);
          return page("Signed in to Antigravity", `${escapeHtml(done.email ?? "Account")} was added to ch-relay. You can close this window.`, true);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          pending.status = { state: "error", message };
          stopLogin(pending);
          return page("Sign-in failed", escapeHtml(message), false);
        }
      },
    });
    pending.timer = setTimeout(() => {
      if (pending.status.state === "pending") pending.status = { state: "error", message: "login timed out after 10 minutes" };
      stopLogin(pending);
    }, LOGIN_TIMEOUT_MS);
    logins.set(loginId, pending);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: listAccounts("antigravity").length ? "consent select_account" : "consent",
      state,
    });
    return { loginId, authUrl: `${AUTH_ENDPOINT}?${params.toString()}` };
  },

  status(loginId: string): LoginStatus {
    return logins.get(loginId)?.status ?? { state: "error", message: "unknown login id" };
  },

  cancel(loginId: string): void {
    const p = logins.get(loginId);
    if (!p) return;
    if (p.status.state === "pending") p.status = { state: "error", message: "cancelled" };
    stopLogin(p);
  },
};
