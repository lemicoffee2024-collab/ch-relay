// Google Antigravity (Cloud Code Assist) provider.
import { coolDown, pickAccount, retryAfterMs } from "../../pool.ts";
import { listAccounts } from "../../store/accounts.ts";
import { kvGet, kvSet } from "../../store/db.ts";
import { ResponsesStreamBuilder, jsonError, sseResponse } from "../../lib/sse.ts";
import { log, redact } from "../../lib/log.ts";
import type { Account, CatalogModel, Provider, ProviderContext } from "../../types.ts";
import { DAILY_API, antigravityUserAgent, apiUrl } from "./constants.ts";
import { AGY_MODELS, parseAvailableModels, toCatalog } from "./models.ts";
import { antigravityLogin, forceRefresh, getAccessToken, getProjectId } from "./oauth.ts";
import { fetchAvailableModelsRaw, quotaScore, refreshAntigravityQuota } from "./quota.ts";
import { buildCcaRequest, buildEnvelope, repairRequest, type BuiltRequest } from "./request.ts";
import { clearSessionSignatures, isSignatureError } from "./signatures.ts";
import { translateCcaStream } from "./stream.ts";

const MAX_RETRIES = 3;
const MAX_ROTATIONS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 2_000;
const MAX_INLINE_WAIT_MS = 10_000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const RATE_COOLDOWN_MS = 30_000;

const QUOTA_NEEDLES = [
  "quotafailure",
  "quota exceeded",
  "exceeded your current quota",
  "billing",
  "individual quota reached",
  "quota reached",
  "enable overages",
  "exhausted your capacity",
  "daily limit reached",
  "weekly limit reached",
];
const TRANSIENT_NEEDLES = [
  "per minute",
  "per-minute",
  "rpm",
  "too many requests",
  "rate limit",
  "retry after",
  "retry-after",
  "concurrent request limit",
];

/** Quota-exhausted 429 (rotate account) vs transient rate limit (retry). */
export function isQuotaExhausted(text: string): boolean {
  const lower = text.toLowerCase();
  if (TRANSIENT_NEEDLES.some((n) => lower.includes(n))) return false;
  return QUOTA_NEEDLES.some((n) => lower.includes(n));
}

function upstreamMessage(text: string, status: number): string {
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string" && m) return m;
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 300) || `HTTP ${status}`;
}

/** RetryInfo.retryDelay ("3.5s") from a Google error body. */
function retryDelayFromBody(text: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function backoff(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

type SendResult =
  | { kind: "ok"; res: Response }
  | { kind: "quota"; ms: number; message: string }
  | { kind: "rate"; ms: number; message: string }
  | { kind: "auth"; message: string }
  | { kind: "error"; status: number; message: string };

async function send(account: Account, token: string, project: string, built: BuiltRequest, ctx: ProviderContext, state: { repaired: boolean }): Promise<SendResult> {
  let refreshed = false;
  let retries = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl(DAILY_API, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": antigravityUserAgent(),
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(buildEnvelope(built, project)),
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (retries >= MAX_RETRIES) return { kind: "error", status: 502, message: `Antigravity network error: ${String(err)}` };
      await Bun.sleep(backoff(retries++));
      continue;
    }
    if (res.ok && res.body) return { kind: "ok", res };

    const text = await res.text().catch(() => "");
    const message = upstreamMessage(text, res.status);
    if (res.status === 401) {
      if (refreshed) return { kind: "auth", message };
      refreshed = true;
      try {
        token = (await forceRefresh(account, ctx.signal)).accessToken;
        continue;
      } catch (err) {
        return { kind: "auth", message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (res.status === 400 && !state.repaired) {
      if (isSignatureError(message)) clearSessionSignatures(built.wire, built.sessionId, built.injectedCallIds);
      if (repairRequest(built, text)) {
        state.repaired = true;
        log.warn(`antigravity 400 repaired and resent: ${redact(message)}`);
        continue;
      }
    }
    const hinted = retryAfterMs(res.headers) ?? retryDelayFromBody(text);
    if (res.status === 429 && isQuotaExhausted(`${message} ${text}`)) {
      return { kind: "quota", ms: Math.min(hinted ?? DEFAULT_QUOTA_COOLDOWN_MS, MAX_COOLDOWN_MS), message };
    }
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      const delay = hinted ?? backoff(retries);
      if (retries >= MAX_RETRIES || delay > MAX_INLINE_WAIT_MS) {
        if (res.status === 429) return { kind: "rate", ms: Math.min(hinted ?? RATE_COOLDOWN_MS, MAX_COOLDOWN_MS), message };
        return { kind: "error", status: res.status, message };
      }
      retries++;
      await Bun.sleep(delay);
      if (ctx.signal.aborted) throw new Error("aborted");
      continue;
    }
    if (res.status === 400 && isSignatureError(message)) clearSessionSignatures(built.wire, built.sessionId, built.injectedCallIds);
    return { kind: "error", status: res.status, message };
  }
}

function streamResponse(res: Response, built: BuiltRequest, account: Account, ctx: ProviderContext): Response {
  const builder = new ResponsesStreamBuilder(ctx.requestedModel);
  async function* run(): AsyncGenerator<string> {
    let status = 200;
    let error: string | undefined;
    let firstTokenMs: number | undefined;
    try {
      yield builder.start();
      const events = translateCcaStream(res.body!, {
        wire: built.wire,
        sessionId: built.sessionId,
        codec: built.codec,
        onSignatureError: () => clearSessionSignatures(built.wire, built.sessionId, built.injectedCallIds),
      });
      for await (const ev of events) {
        if (firstTokenMs === undefined && (ev.type === "text_delta" || ev.type === "reasoning_delta" || ev.type === "tool_call")) {
          firstTokenMs = Date.now() - ctx.startedAt;
        }
        if (ev.type === "error") {
          status = 502;
          error = ev.message;
        }
        const chunk = builder.push(ev);
        if (chunk) yield chunk;
      }
      if (!builder.isFinished) {
        status = 502;
        error = "Antigravity stream ended unexpectedly";
        yield builder.push({ type: "error", message: error });
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        if (!builder.isFinished) {
          status = 499;
          error = "client disconnected";
        }
      } else {
        status = 502;
        error = err instanceof Error ? err.message : String(err);
        yield builder.push({ type: "error", message: `Antigravity stream failed: ${redact(error)}` });
      }
    } finally {
      ctx.finish({ accountId: account.id, servedModel: built.wire, status, usage: builder.finalUsage, error, firstTokenMs });
    }
  }
  return sseResponse(run());
}

async function handle(ctx: ProviderContext): Promise<Response> {
  const built = buildCcaRequest(ctx.body, ctx.model, ctx.effort, ctx.sessionKey);
  const exclude = new Set<string>();
  const state = { repaired: false };
  let rotations = 0;
  let last: { status: number; message: string; code: string } | null = null;

  const fail = (status: number, message: string, code: string, accountId: string | null) => {
    ctx.finish({ accountId, servedModel: built.wire, status, error: message });
    return jsonError(status, redact(message), code);
  };

  while (true) {
    const account = pickAccount("antigravity", {
      sessionKey: ctx.sessionKey,
      scope: built.family,
      exclude,
      score: (a) => quotaScore(a.id, built.family),
    });
    if (!account) {
      if (last) return fail(last.status, last.message, last.code, null);
      const none = listAccounts("antigravity").length === 0;
      return fail(
        none ? 401 : 429,
        none ? "no Antigravity account configured" : `all Antigravity accounts are cooling down for ${built.family === "gem" ? "Gemini" : "Claude/GPT-OSS"} models`,
        none ? "no_account" : "rate_limit_exceeded",
        null,
      );
    }
    exclude.add(account.id);

    let token: string;
    let project: string;
    try {
      token = await getAccessToken(account, ctx.signal);
      project = await getProjectId(account, token, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) return fail(499, "client disconnected", "aborted", account.id);
      last = { status: 401, message: `Antigravity auth failed for ${account.label}: ${err instanceof Error ? err.message : String(err)}`, code: "auth_error" };
      log.warn(last.message);
      continue;
    }

    let r: SendResult;
    try {
      r = await send(account, token, project, built, ctx, state);
    } catch (err) {
      return fail(499, ctx.signal.aborted ? "client disconnected" : String(err), "aborted", account.id);
    }

    switch (r.kind) {
      case "ok":
        return streamResponse(r.res, built, account, ctx);
      case "quota":
      case "rate": {
        coolDown(account.id, built.family, r.ms, `${r.kind === "quota" ? "quota exhausted" : "rate limited"}: ${redact(r.message)}`);
        log.warn(`antigravity ${account.label} ${r.kind} (${built.family}) cooldown ${Math.round(r.ms / 1000)}s`);
        if (r.kind === "quota") void refreshAntigravityQuota(account).catch(() => {});
        last = { status: 429, message: `Antigravity ${r.kind === "quota" ? "quota exhausted" : "rate limit"}: ${r.message}`, code: "rate_limit_exceeded" };
        if (++rotations > MAX_ROTATIONS) return fail(last.status, last.message, last.code, account.id);
        continue;
      }
      case "auth":
        last = { status: 401, message: `Antigravity authentication failed: ${r.message}`, code: "auth_error" };
        if (++rotations > MAX_ROTATIONS) return fail(last.status, last.message, last.code, account.id);
        continue;
      case "error":
        return fail(r.status, `Antigravity error ${r.status}: ${r.message}`, r.status >= 500 ? "upstream_error" : "invalid_request_error", account.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Models (static list, context windows refined from fetchAvailableModels)
// ---------------------------------------------------------------------------

const MODELS_KV = { ns: "agy.models", key: "available" };
const MODELS_TTL_MS = 60 * 60 * 1000;
const MODELS_FAIL_TTL_MS = 5 * 60 * 1000;
let discovery: Promise<void> | null = null;

function discover(): Promise<void> {
  discovery ??= (async () => {
    const acc = listAccounts("antigravity").find((a) => a.enabled && a.status !== "needs_reauth");
    if (!acc) return;
    try {
      const parsed = parseAvailableModels(await fetchAvailableModelsRaw(acc));
      kvSet(MODELS_KV.ns, MODELS_KV.key, JSON.stringify(Object.fromEntries(parsed)), MODELS_TTL_MS);
    } catch (err) {
      log.debug("antigravity model discovery failed", String(err));
      kvSet(MODELS_KV.ns, MODELS_KV.key, "{}", MODELS_FAIL_TTL_MS);
    }
  })().finally(() => {
    discovery = null;
  });
  return discovery;
}

async function models(): Promise<CatalogModel[]> {
  let raw = kvGet(MODELS_KV.ns, MODELS_KV.key);
  if (raw === null && listAccounts("antigravity").length) {
    await Promise.race([discover(), Bun.sleep(5_000)]);
    raw = kvGet(MODELS_KV.ns, MODELS_KV.key);
  }
  let found: Record<string, { contextWindow?: number }> = {};
  try {
    found = raw ? JSON.parse(raw) : {};
  } catch {
    /* ignore */
  }
  return AGY_MODELS.map((def) => toCatalog(def, found[def.id]?.contextWindow ?? def.contextWindow));
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  handle,
  models,
  login: antigravityLogin,
  refreshQuota: refreshAntigravityQuota,
};
