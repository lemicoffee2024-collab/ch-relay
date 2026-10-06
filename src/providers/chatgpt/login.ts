// ChatGPT OAuth login: browser (authorization code + PKCE, callback on 127.0.0.1:1455)
// with a device-code fallback when the port is busy or the caller asks for it.

import { upsertAccount } from "../../store/accounts.ts";
import { pinnedFetch } from "../../net/pin.ts";
import { log } from "../../lib/log.ts";
import type { Account, LoginFlow, LoginStart, LoginStatus } from "../../types.ts";
import {
  buildAuthUrl,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CLIENT_ID,
  credentialFromTokens,
  DEVICE_REDIRECT_URI,
  DEVICE_TOKEN_URL,
  DEVICE_USERCODE_URL,
  DEVICE_VERIFICATION_URL,
  exchangeCode,
  generatePkce,
  randomState,
  REDIRECT_URI,
  tokenIdentity,
  type TokenResponse,
} from "./oauth.ts";

export const LOGIN_TTL_MS = 10 * 60_000;
/** Finished logins stay queryable for a while so the GUI can read the result. */
const KEEP_FINISHED_MS = 10 * 60_000;

interface LoginEntry {
  id: string;
  status: LoginStatus;
  abort: AbortController;
  cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const logins = new Map<string, LoginEntry>();
/** Only one browser flow can own port 1455 at a time. */
let activeCallbackLogin: string | null = null;

function newLoginId(): string {
  return `chatgpt-login-${crypto.randomUUID()}`;
}

function settle(id: string, status: LoginStatus): void {
  const e = logins.get(id);
  if (!e || e.status.state !== "pending") return;
  e.status = status;
  clearTimeout(e.timer);
  try {
    e.cleanup();
  } catch {
    /* ignore */
  }
  e.abort.abort();
  const t = setTimeout(() => logins.delete(id), KEEP_FINISHED_MS);
  (t as { unref?: () => void }).unref?.();
}

function register(id: string, cleanup: () => void): LoginEntry {
  const timer = setTimeout(() => settle(id, { state: "error", message: "login expired (10 minutes)" }), LOGIN_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  const entry: LoginEntry = { id, status: { state: "pending" }, abort: new AbortController(), cleanup, timer };
  logins.set(id, entry);
  return entry;
}

/** Store (or update, deduped by email) the account for a token response. */
export function saveLoginTokens(tokens: TokenResponse): Account {
  const credential = credentialFromTokens(tokens);
  const ident = tokenIdentity(credential.idToken, credential.accessToken);
  if (!credential.chatgptAccountId) throw new Error("ChatGPT login returned no account id");
  if (!credential.refreshToken) throw new Error("ChatGPT login returned no refresh token");
  const email = ident.email ?? null;
  const meta: Record<string, unknown> = {};
  if (ident.plan) meta.plan = ident.plan;
  return upsertAccount(
    { provider: "chatgpt", label: email ?? credential.chatgptAccountId, email, credential, meta },
    { email },
  );
}

const PAGE_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f";

function page(title: string, detail: string, ok: boolean): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ch-relay</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${PAGE_STYLE}"><div style="text-align:center;padding:40px 48px;background:#fff;border-radius:18px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px">
<div style="font-size:40px;line-height:1;color:${ok ? "#34c759" : "#ff3b30"}">${ok ? "&#10003;" : "&#10005;"}</div>
<h1 style="font-size:20px;font-weight:600;margin:16px 0 8px">${esc(title)}</h1>
<p style="font-size:14px;color:#6e6e73;margin:0">${esc(detail)}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

type Server = ReturnType<typeof Bun.serve>;

function tryListen(fetchHandler: (req: Request) => Promise<Response> | Response): Server | null {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: CALLBACK_PORT, fetch: fetchHandler });
  } catch (err) {
    log.warn(`chatgpt login: cannot listen on 127.0.0.1:${CALLBACK_PORT}, using device code`, String(err));
    return null;
  }
}

async function startBrowser(): Promise<LoginStart | null> {
  // A new browser login replaces any previous one (they share the callback port).
  if (activeCallbackLogin) settle(activeCallbackLogin, { state: "error", message: "superseded by a newer login" });

  const id = newLoginId();
  const pkce = await generatePkce();
  const state = randomState();
  let server: Server | null = null;
  let handled = false;

  server = tryListen(async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
    const entry = logins.get(id);
    if (!entry || entry.status.state !== "pending" || handled) {
      return page("Login already finished", "You can close this tab.", entry?.status.state === "done");
    }
    if (url.searchParams.get("state") !== state) return page("Sign-in failed", "State mismatch. Start the login again.", false);
    const err = url.searchParams.get("error");
    if (err) {
      handled = true;
      const msg = url.searchParams.get("error_description") ?? err;
      settle(id, { state: "error", message: `authorization failed: ${msg}` });
      return page("Sign-in failed", msg, false);
    }
    const code = url.searchParams.get("code");
    if (!code) return page("Sign-in failed", "Missing authorization code.", false);
    handled = true;
    try {
      const tokens = await exchangeCode(code, pkce.verifier, REDIRECT_URI, entry.abort.signal);
      const acc = saveLoginTokens(tokens);
      log.info(`chatgpt login ok: ${acc.label}`);
      settle(id, { state: "done", accountId: acc.id, email: acc.email });
      return page("Signed in", "You can close this tab and return to ch-relay.", true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      settle(id, { state: "error", message: msg });
      return page("Sign-in failed", msg, false);
    }
  });
  if (!server) return null;

  const srv = server;
  register(id, () => {
    if (activeCallbackLogin === id) activeCallbackLogin = null;
    // Let the callback response flush before closing the listener.
    setTimeout(() => srv.stop(true), 250);
  });
  activeCallbackLogin = id;
  return { loginId: id, authUrl: buildAuthUrl(pkce.challenge, state) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

function fetchSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

async function startDevice(): Promise<LoginStart> {
  const res = await pinnedFetch(DEVICE_USERCODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ChatGPT device code request failed: HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const deviceAuthId = typeof j.device_auth_id === "string" ? j.device_auth_id : "";
  const userCode = typeof j.user_code === "string" ? j.user_code : typeof j.usercode === "string" ? j.usercode : "";
  if (!deviceAuthId || !userCode) throw new Error("ChatGPT device code response missing fields");
  const secs = Number(j.interval);
  const intervalMs = Math.min(60_000, Math.max(1_000, Number.isFinite(secs) && secs > 0 ? secs * 1000 : 5_000));

  const id = newLoginId();
  const entry = register(id, () => {});
  void pollDevice(id, entry.abort.signal, deviceAuthId, userCode, intervalMs);
  return { loginId: id, userCode, verificationUrl: DEVICE_VERIFICATION_URL };
}

async function pollDevice(id: string, signal: AbortSignal, deviceAuthId: string, userCode: string, intervalMs: number): Promise<void> {
  try {
    while (!signal.aborted) {
      const res = await pinnedFetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal: fetchSignal(signal),
      });
      if (res.status === 403 || res.status === 404) {
        await res.body?.cancel().catch(() => {});
        await sleep(intervalMs, signal);
        continue;
      }
      if (!res.ok) throw new Error(`ChatGPT device authorization failed: HTTP ${res.status}`);
      const j = (await res.json()) as Record<string, unknown>;
      const code = typeof j.authorization_code === "string" ? j.authorization_code : "";
      const verifier = typeof j.code_verifier === "string" ? j.code_verifier : "";
      if (!code || !verifier) throw new Error("ChatGPT device authorization response missing fields");
      const tokens = await exchangeCode(code, verifier, DEVICE_REDIRECT_URI, fetchSignal(signal));
      const acc = saveLoginTokens(tokens);
      log.info(`chatgpt device login ok: ${acc.label}`);
      settle(id, { state: "done", accountId: acc.id, email: acc.email });
      return;
    }
  } catch (err) {
    if (signal.aborted) return; // cancelled or expired: status already settled
    settle(id, { state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export const chatgptLogin: LoginFlow = {
  async start(opts) {
    if (!opts?.device) {
      const browser = await startBrowser();
      if (browser) return browser;
    }
    return startDevice();
  },
  status(loginId) {
    return logins.get(loginId)?.status ?? { state: "error", message: "unknown or expired login" };
  },
  cancel(loginId) {
    settle(loginId, { state: "error", message: "cancelled" });
  },
};
