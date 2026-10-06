// ChatGPT provider: OAuth pool accounts forwarded to the ChatGPT Codex backend.

import type { Account, Provider, ProviderContext, RequestOutcome } from "../../types.ts";
import { coolDown, pickAccount, retryAfterMs } from "../../pool.ts";
import { getCooldowns, listAccounts, patchMeta, setStatus } from "../../store/accounts.ts";
import { jsonError } from "../../lib/sse.ts";
import { pinnedFetch } from "../../net/pin.ts";
import { log, redact } from "../../lib/log.ts";
import { InputAudit } from "../../lib/input-audit.ts";
import { isBunAsyncPullCancelUnsafe } from "../../lib/bun-stream-caps.ts";
import { chatgptCatalogModels, chatgptWireModel } from "./catalog.ts";
import { chatgptLogin } from "./login.ts";
import { applyQuotaHeaders, earliestHeaderReset, fetchWhamUsage, mergeQuota, parseWhamUsage, toEpochMs, usageScore } from "./quota.ts";
import {
  ensureFreshCredential,
  ReauthRequiredError,
  refreshAfterUnauthorized,
  TransientAuthError,
} from "./tokens.ts";
import {
  buildUpstreamHeaders,
  COMPACT_URL,
  downstreamHeaders,
  imagesUrl,
  isServedModel,
  RESPONSES_URL,
  SseScanner,
  upstreamBody,
  usageFromResponses,
} from "./upstream.ts";
import type { ChatgptCredential } from "./oauth.ts";
import { POLICY } from "../../share/policy.ts";
import {
  injectAdditionalToolPad,
  injectArgsPad,
  injectArgsPadSoft,
  injectJsonLane,
  injectPadCall,
  learnReservedTool,
  markerInstruction,
  markerUserNote,
  pickLightWire,
  sentinelInstruction,
  shareAutoCutChars,
  shareAutoCutStream,
  shareJsonLaneEnabled,
  toolPadInstruction,
  trimToolOutputs,
} from "../../share/autocut.ts";

/** Accounts at/above this usage score are only used when nothing else is available. */
export const USAGE_THRESHOLD = 90;
/** Account switches allowed per request after 429/402/5xx/auth failures. */
const MAX_SWITCHES = 1;
/** 429/402 cost nothing upstream and cool the account, so walk the whole pool. */
const MAX_QUOTA_SWITCHES = 8;
const MAX_COOLDOWN_MS = 24 * 3600_000;
const RESET_COOLDOWN_CAP_MS = 15 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
// Upstream connect+headers can hang silently (edge queue, half-open socket):
// bound each attempt so account-switch retries engage before the client gives
// up.
const UPSTREAM_HDR_MS = () =>
  Number(process.env.CH_UPSTREAM_HDR_MS ?? POLICY.limits.upstreamHdrMs ?? 20_000);
const WORKSPACE_CODES = new Set(["workspace_access_denied", "entitlement_missing"]);

const score = (a: Account) => usageScore(a.id);

/** Cooldown length: Retry-After -> error reset hint -> earliest quota reset (capped) -> 60s. */
export function cooldownMs(headers: Headers | undefined, err?: Record<string, any> | null): number {
  const now = Date.now();
  const ra = headers ? retryAfterMs(headers) : undefined;
  if (ra !== undefined && ra > 0) return Math.min(ra, MAX_COOLDOWN_MS);
  const inSecs = Number(err?.resets_in_seconds);
  if (Number.isFinite(inSecs) && inSecs > 0) return Math.min(inSecs * 1000, MAX_COOLDOWN_MS);
  const at = toEpochMs(err?.resets_at);
  if (at !== undefined && at > now) return Math.min(at - now, MAX_COOLDOWN_MS);
  const reset = headers ? earliestHeaderReset(headers, now) : undefined;
  if (reset !== undefined) return Math.min(reset - now, RESET_COOLDOWN_CAP_MS);
  return DEFAULT_COOLDOWN_MS;
}

function errorObject(text: string): Record<string, any> | null {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      if (j.error && typeof j.error === "object") return j.error;
      if (typeof j.detail === "object" && j.detail) return j.detail;
      return j;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function errorCode(text: string): string | undefined {
  const e = errorObject(text);
  const c = e?.code ?? e?.type;
  return typeof c === "string" ? c : undefined;
}

/** Response returned when no account can serve the request. */
function noAccountResponse(lastError?: string): Response {
  const accs = listAccounts("chatgpt").filter((a) => a.enabled);
  if (accs.length === 0) return jsonError(429, "No enabled ChatGPT accounts. Sign in on the ch-relay Accounts page.", "no_accounts");
  const usable = accs.filter((a) => a.status !== "needs_reauth");
  if (usable.length === 0) {
    return jsonError(429, "All ChatGPT accounts need to sign in again (refresh token revoked or expired).", "needs_reauth");
  }
  const ends = usable.flatMap((a) => getCooldowns(a.id).map((c) => c.until)).filter((t) => t > Date.now());
  if (ends.length) {
    const soonest = Math.min(...ends);
    const secs = Math.max(1, Math.ceil((soonest - Date.now()) / 1000));
    const res = Response.json(
      {
        error: {
          message: `All ChatGPT accounts are cooling down. The soonest is available at ${new Date(soonest).toISOString()} (in ${fmtDuration(secs)}).`,
          type: "usage_limit_reached",
          code: "usage_limit_reached",
          resets_in_seconds: secs,
        },
      },
      { status: 429, headers: { "retry-after": String(secs) } },
    );
    return res;
  }
  return jsonError(429, `No ChatGPT account could serve the request${lastError ? `: ${redact(lastError)}` : "."}`, "no_account_available");
}

function fmtDuration(secs: number): string {
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

interface Failure {
  status: number;
  headers: Headers;
  text: string;
  accountId: string;
}

type DispatchResult =
  | { ok: true; res: Response; account: Account }
  | { ok: false; response: Response; outcome: RequestOutcome };

function failureResponse(f: Failure): Response {
  const h = new Headers({ "content-type": f.headers.get("content-type") ?? "application/json" });
  for (const n of ["retry-after", "x-codex-primary-reset-at", "x-codex-secondary-reset-at", "x-codex-tertiary-reset-at"]) {
    const v = f.headers.get(n);
    if (v) h.set(n, v);
  }
  return new Response(f.text, { status: f.status, headers: h });
}

/**
 * Choose an account, send, and apply the error policy (refresh+replay on 401/403,
 * cooldown + one switch on 429/402, one switch on 5xx). A successful (2xx) upstream
 * response is returned unread.
 */
async function dispatch(
  ctx: ProviderContext,
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  accept: string,
  contentType = "application/json",
  inputAudit?: InputAudit,
): Promise<DispatchResult> {
  const tried = new Set<string>();
  let switches = 0;
  let last: Failure | undefined;
  let lastError: string | undefined;

  const send = async (cred: ChatgptCredential) => {
    if (typeof body === "string") inputAudit?.sent(body);
    // Bound connect+headers only: the abort signal stays linked to the
    // response body in fetch, so firing it after resolve would sever a
    // healthy stream. Clear on resolve instead.
    const ac = new AbortController();
    const hdrTimer = setTimeout(() => ac.abort(new Error("upstream headers timeout")), UPSTREAM_HDR_MS());
    try {
      return await pinnedFetch(url, {
        method: "POST",
        headers: buildUpstreamHeaders(ctx.headers, cred.accessToken, cred.chatgptAccountId, accept, contentType),
        body,
        signal: AbortSignal.any([ctx.signal, ac.signal]),
      });
    } finally {
      clearTimeout(hdrTimer);
    }
  };

  const fail = (f: Failure | undefined, msg: string | undefined): DispatchResult => {
    if (f) {
      return {
        ok: false,
        response: failureResponse(f),
        outcome: { accountId: f.accountId, servedModel: ctx.model, status: f.status, error: redact(f.text || msg || `HTTP ${f.status}`) },
      };
    }
    const response = ctx.signal.aborted ? jsonError(499, "client cancelled", "client_cancelled") : noAccountResponse(msg);
    return { ok: false, response, outcome: { accountId: null, servedModel: ctx.model, status: response.status, error: msg ?? "no account available" } };
  };

  while (true) {
    if (ctx.signal.aborted) return fail(undefined, "client cancelled");
    const acc = pickAccount("chatgpt", { sessionKey: ctx.sessionKey, exclude: tried, score, threshold: USAGE_THRESHOLD });
    if (!acc) return fail(last, lastError);
    tried.add(acc.id);

    let cred: ChatgptCredential;
    try {
      cred = await ensureFreshCredential(acc);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue; // needs_reauth / refresh backoff: try another account
    }
    if (!cred.chatgptAccountId) {
      lastError = "account has no chatgpt account id";
      continue;
    }

    let res: Response;
    try {
      res = await send(cred);
    } catch (err) {
      if (ctx.signal.aborted) return fail(undefined, "client cancelled");
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(`chatgpt upstream network error acct=${acc.id}`, lastError);
      if (switches++ < MAX_SWITCHES) continue;
      return fail(undefined, lastError);
    }
    applyQuotaHeaders(acc.id, res.headers);

    // --- 401/403: refresh once and replay once ---
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const code = errorCode(text);
      if (res.status === 403 && code && WORKSPACE_CODES.has(code)) {
        last = { status: res.status, headers: res.headers, text, accountId: acc.id };
        log.warn(`chatgpt ${code} acct=${acc.id}`);
        if (switches++ < MAX_SWITCHES) continue;
        return fail(last, undefined);
      }
      try {
        cred = await refreshAfterUnauthorized(acc, cred.accessToken);
        res = await send(cred);
        applyQuotaHeaders(acc.id, res.headers);
      } catch (err) {
        if (ctx.signal.aborted) return fail(undefined, "client cancelled");
        lastError = err instanceof Error ? err.message : String(err);
        last = { status: res.status, headers: res.headers, text, accountId: acc.id };
        if (!(err instanceof TransientAuthError) && !(err instanceof ReauthRequiredError)) {
          log.warn(`chatgpt replay failed acct=${acc.id}`, lastError);
        }
        if (switches++ < MAX_SWITCHES) continue;
        return fail(last, lastError);
      }
      if (res.status === 401 || res.status === 403) {
        const text2 = await res.text().catch(() => "");
        setStatus(acc.id, "needs_reauth", `upstream ${res.status} after token refresh`);
        log.warn(`chatgpt acct=${acc.id} still ${res.status} after refresh -> needs_reauth`);
        last = { status: res.status, headers: res.headers, text: text2, accountId: acc.id };
        if (switches++ < MAX_SWITCHES) continue;
        return fail(last, undefined);
      }
    }

    if (res.ok) {
      if (acc.status === "error") setStatus(acc.id, "ok");
      return { ok: true, res, account: acc };
    }

    const text = await res.text().catch(() => "");
    last = { status: res.status, headers: res.headers, text, accountId: acc.id };

    if (res.status === 429 || res.status === 402) {
      const ms = cooldownMs(res.headers, errorObject(text));
      const code = errorCode(text) ?? `http_${res.status}`;
      coolDown(acc.id, "*", ms, code);
      log.warn(`chatgpt ${res.status} ${code} acct=${acc.id} cooldown ${Math.round(ms / 1000)}s`);
      if (switches++ < MAX_QUOTA_SWITCHES) continue;
      return fail(last, undefined);
    }
    if (res.status >= 500 && res.status <= 599) {
      log.warn(`chatgpt upstream ${res.status} acct=${acc.id}`, redact(text));
      if (switches++ < MAX_SWITCHES) continue;
      return fail(last, undefined);
    }
    // Other 4xx (bad request, unknown model, ...) are the caller's problem: pass through.
    return fail(last, undefined);
  }
}

/** Fail loud when upstream reports it served a different model than requested. */
function reportedMismatch(ctx: ProviderContext, res: Response, accountId: string | null, wire: string): Response | null {
  const reported = res.headers.get("openai-model");
  if (!reported || isServedModel(wire, reported)) return null;
  void res.body?.cancel().catch(() => {});
  ctx.finish({ accountId, servedModel: reported, status: 502, error: `upstream reported model ${reported}` });
  return jsonError(502, "Upstream did not serve the requested model.", "model_mismatch");
}

async function handle(ctx: ProviderContext): Promise<Response> {
  const wire = chatgptWireModel(ctx.model);
  const inputAudit = new InputAudit("pool", wire);
  const report = ctx.finish.bind(ctx);
  ctx = { ...ctx, finish: outcome => { inputAudit.finish(outcome); report(outcome); } };
  const parsed = upstreamBody(ctx.body, wire, ctx.headers) as Record<string, any>;
  // Shorten stale tool text; log content sizes separately from reported usage.
  // This applies to every variant of the body we may send.
  inputAudit.capture("before", parsed);
  const trimmed = trimToolOutputs(parsed);
  inputAudit.capture("inputtrim", parsed);
  if (trimmed) log.info(`inputtrim items=${trimmed} model=${wire}`);
  // Optional light-model reroute for trivial tool-free traffic.
  const upWire = pickLightWire(parsed) ?? wire;
  if (upWire !== wire) parsed.model = upWire;
  const isAstra = upWire.startsWith("gpt-6-astra");
  const cutAt = shareAutoCutChars(ctx.headers);
  let bodyText = JSON.stringify(parsed);
  let markerOnlyText: string | undefined;
  let softText: string | undefined;
  let plainBody: string | undefined;
  let padRequired: Record<string, string[]> | undefined;
  let codePad: Set<string> | undefined;
  let aliasOf: Record<string, string> | undefined;
  let softAliasOf: Record<string, string> | undefined;
  let softCodePad: Set<string> | undefined;
  let softPadRequired: Record<string, string[]> | undefined;
  let autocutBody: Record<string, any> | undefined;
  let jsonLane = false;
  if (cutAt !== null) {
    // Same injection set as the share lane: marker/pad instructions, schema
    // arg pads and additional_tools grammar/description padding.
    plainBody = bodyText;
    const inj335 = isAstra ? `${toolPadInstruction()}\n\n${sentinelInstruction()}` : markerInstruction();
    const instr335 = (parsed.instructions as string) ?? "";
    if (instr335.trim()) {
      parsed.instructions = `${instr335}\n\n${inj335}`;
    } else if (Array.isArray(parsed.input)) {
      // Empty instructions: don't let pad rules occupy the privileged
      // instructions channel — deliver them as a developer input message.
      parsed.input = [
        ...parsed.input,
        { type: "message", role: "developer", content: [{ type: "input_text", text: inj335 }] },
      ];
    } else {
      parsed.instructions = inj335;
    }
    if (!isAstra && Array.isArray(parsed.input)) {
      parsed.input = [
        ...parsed.input,
        { type: "message", role: "user", content: [{ type: "input_text", text: markerUserNote() }] },
      ];
    }
    // Companion pad-call: a bookkeeping tool the model is told to emit last.
    // Its `added` event is a provable mid-generation abort point — the only
    // pad that survives reserved-schema tools since we never mutate theirs.
    // Injected before markerOnlyText so the 400-fallback keeps it. Skipped on
    // astra: it ignores the rule and virtual-tool padding is disallowed there.
    if (!isAstra) injectPadCall(parsed);
    markerOnlyText = JSON.stringify(parsed);
    // Soft tier: markerOnly + optional pad prop + description hints. Survives
    // strict-schema rejections — nothing in it can 400 that marker can't.
    const softParsed = JSON.parse(markerOnlyText) as Record<string, any>;
    const softPads = injectAdditionalToolPad(softParsed) ?? undefined;
    if (injectArgsPadSoft(softParsed) || softPads) {
      softText = JSON.stringify(softParsed);
      softCodePad = softPads?.codePad;
      softPadRequired = softPads?.padRequired;
      softAliasOf = softPads?.aliasOf;
    }
    if (Array.isArray(parsed.tools) && parsed.tools.length) {
      padRequired = {};
      for (const t of parsed.tools) {
        if (t?.type === "function")
          padRequired[String(t.name)] = Array.isArray(t.parameters?.required) ? [...t.parameters.required] : [];
      }
      injectArgsPad(parsed);
    }
    const atPads = injectAdditionalToolPad(parsed);
    if (atPads) {
      codePad = atPads.codePad;
      padRequired = { ...padRequired, ...atPads.padRequired };
      aliasOf = atPads.aliasOf;
    }
    // Same json lane as the share side: pin text output to {"answer","notes"}
    // so a text-only turn must keep generating after the answer — enforced by
    // constrained decoding, not the model's goodwill. markerOnlyText (taken
    // before this) stays schema-free for the 400 fallback. Astra is excluded:
    // its text turns ride the sentinel — a sentinel inside the JSON envelope
    // would cut the object mid-string.
    if (!isAstra && shareJsonLaneEnabled() && injectJsonLane(parsed)) {
      jsonLane = true;
    }
    inputAudit.capture("injected", parsed);
    autocutBody = parsed;
    bodyText = JSON.stringify(parsed);
  }
  let d = await dispatch(ctx, RESPONSES_URL, bodyText, "text/event-stream", "application/json", inputAudit);
  // Fallback chain on 400: strict/mutated body → soft pad tier → marker only.
  for (let fb of [softText, markerOnlyText]) {
    if (!fb || d.ok || d.response.status !== 400) continue;
    // Read the rejection before cancelling: reserved-schema errors name the
    // locked function — learn it so later bodies skip that pad entirely.
    const errText = await d.response.text().catch(() => "");
    const learned = learnReservedTool(errText);
    if (learned.length && fb === softText && markerOnlyText) {
      // Regenerate the soft tier without the just-locked schema so this
      // request keeps every other pad instead of dropping to marker-only.
      const regen = JSON.parse(markerOnlyText) as Record<string, any>;
      const sp2 = injectArgsPadSoft(regen);
      const scp2 = injectAdditionalToolPad(regen) ?? undefined;
      if (sp2 || scp2) {
        softText = JSON.stringify(regen);
        fb = softText;
        softCodePad = scp2?.codePad;
        softPadRequired = scp2?.padRequired;
        softAliasOf = scp2?.aliasOf;
      }
    }
    const retry = await dispatch(ctx, RESPONSES_URL, fb, "text/event-stream", "application/json", inputAudit);
    if (!retry.ok) { d = retry; continue; }
    d = retry;
    autocutBody = JSON.parse(fb) as Record<string, any>;
    jsonLane = false;
    if (fb === markerOnlyText) {
      padRequired = undefined;
      codePad = undefined;
      aliasOf = undefined;
    } else {
      codePad = softCodePad;
      padRequired = { ...padRequired, ...softPadRequired };
      aliasOf = softAliasOf;
    }
    break;
  }
  if (!d.ok) {
    ctx.finish(d.outcome);
    return d.response;
  }
  const mismatch = reportedMismatch(ctx, d.res, d.account.id, upWire);
  if (mismatch) return mismatch;
  if (cutAt !== null && autocutBody && d.res.body) {
    const headers = downstreamHeaders(d.res.headers);
    const servedHeader = d.res.headers.get("openai-model");
    if (servedHeader) headers.set("openai-model", ctx.requestedModel);
    const fetchSeg = async (segBody: string): Promise<Response> => {
      const seg = await dispatch(ctx, RESPONSES_URL, segBody, "text/event-stream", "application/json", inputAudit);
      if (!seg.ok) throw new Error(`segment upstream ${seg.response.status}`);
      return seg.res;
    };
    return new Response(
      shareAutoCutStream({
        cutAt,
        wire: upWire,
        requestedModel: ctx.requestedModel,
        signal: ctx.signal,
        started: ctx.startedAt,
        first: d.res,
        fetchSeg,
        origBody: autocutBody,
        plainBody,
        cleanEcho: plainBody ? (JSON.parse(plainBody) as Record<string, any>) : undefined,
        jsonSchema: jsonLane,
        padRequired,
        codePad,
        aliasOf,
        done: (o) => {
          if (o.error && /usage_limit_reached|rate_limit_exceeded|insufficient_quota/.test(o.error)) {
            coolDown(d.account.id, "*", cooldownMs(undefined, null), o.error.slice(0, 40));
          }
          ctx.finish({ accountId: d.account.id, ...o });
        },
      }),
      { status: d.res.status, headers },
    );
  }
  return streamThrough(ctx, d.res, d.account, upWire);
}

/** Pipe upstream bytes to Codex unchanged while side-scanning for usage/errors. */
export function streamThrough(ctx: ProviderContext, res: Response, acc: Account, wire: string): Response {
  const cutAt = autoCutChars(ctx.headers);
  if (cutAt !== null) return streamThroughAutoCut(ctx, res, acc, wire, cutAt);
  const scanner = new SseScanner();
  const headers = downstreamHeaders(res.headers);
  const servedHeader = res.headers.get("openai-model") ?? undefined;
  // Codex raises model/rerouted when openai-model differs from the slug it asked for.
  if (servedHeader) headers.set("openai-model", ctx.requestedModel);
  const unsafeAsyncPullCancel = isBunAsyncPullCancelUnsafe();
  let firstByteAt: number | undefined;
  let done = false;
  let readPending = false;
  let cancelRequested = false;
  let cancelReason: unknown;
  let readerCancel: Promise<void> | undefined;

  const cancelReader = (reason?: unknown): Promise<void> => {
    if (!readerCancel) {
      // Keep the cancel call out of the current pull stack on affected Bun
      // versions, even after read() has settled.
      readerCancel = unsafeAsyncPullCancel
        ? Promise.resolve().then(() => reader.cancel(reason)).catch(() => {})
        : reader.cancel(reason).catch(() => {});
    }
    return readerCancel;
  };

  const finish = (error?: string) => {
    if (done) return;
    done = true;
    if (scanner.quotaFailure) {
      const ms = cooldownMs(undefined, scanner.failedError);
      coolDown(acc.id, "*", ms, scanner.failedCode!);
      log.warn(`chatgpt in-stream ${scanner.failedCode} acct=${acc.id} cooldown ${Math.round(ms / 1000)}s`);
    }
    const first = scanner.firstDeltaAt ?? firstByteAt;
    // Codex drops the socket as soon as it has the items it needs, often after
    // response.completed already flowed through. Only count a disconnect as a
    // cancellation when the response never completed upstream.
    const cancelled = (cancelRequested || ctx.signal.aborted) && !scanner.completed;
    const err = cancelled
      ? "client cancelled"
      : (scanner.completed && error === "client cancelled" ? undefined : error) ?? (scanner.failedCode ? `${scanner.failedCode}${scanner.failedMessage ? `: ${scanner.failedMessage}` : ""}` : undefined);
    // Prefer the header's dated snapshot id, but a payload reporting a different
    // model family is the anomaly that must be recorded.
    const anomaly = scanner.model && !isServedModel(wire, scanner.model) ? scanner.model : undefined;
    const servedModel = anomaly ?? servedHeader ?? scanner.model ?? wire;
    if (anomaly) log.warn(`chatgpt upstream served ${servedModel} for requested ${wire} acct=${acc.id}`);
    ctx.finish({
      accountId: acc.id,
      servedModel,
      status: cancelled ? 499 : res.status,
      usage: scanner.usage,
      firstTokenMs: first !== undefined ? first - ctx.startedAt : undefined,
      ...(err ? { error: redact(err) } : {}),
    });
  };

  if (!res.body) {
    finish();
    return new Response(null, { status: res.status, headers });
  }
  const reader = res.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelRequested) return;
      readPending = true;
      try {
        const { value, done: eof } = await reader.read();
        readPending = false;
        if (cancelRequested || ctx.signal.aborted) {
          await cancelReader(cancelReason);
          finish("client cancelled");
          return;
        }
        if (eof) {
          scanner.end();
          finish(scanner.completed || scanner.failedCode ? undefined : "stream ended without response.completed");
          controller.close();
          return;
        }
        if (value?.byteLength) {
          firstByteAt ??= Date.now();
          scanner.push(value);
          controller.enqueue(value);
        }
      } catch (err) {
        readPending = false;
        if (cancelRequested || ctx.signal.aborted) {
          await cancelReader(cancelReason);
          finish("client cancelled");
          return;
        }
        finish(`stream error: ${err instanceof Error ? err.message : String(err)}`);
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelRequested = true;
      cancelReason = reason;
      finish("client cancelled");
      // On affected Bun versions, calling cancel while read() is pending can
      // re-enter the stream pull and crash the runtime. The upstream fetch is
      // still tied to ctx.signal; wait for read() to settle before cancelling
      // this reader. On fixed runtimes the same ordering is harmless and keeps
      // cancellation behavior deterministic.
      if (readPending) return Promise.resolve();
      return cancelReader(reason);
    },
  });
  return new Response(stream, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Auto-cut (metering research, opt-in)
// ---------------------------------------------------------------------------

/**
 * Per-request char budget for the auto-cut path. `x-ch-autocut: <chars>`
 * enables it per request (never forwarded upstream — FORWARD_HEADERS is a
 * whitelist); CH_AUTOCUT_CHARS sets a server-wide default. "off"/0
 * disables. Returns null when disabled.
 */
function autoCutChars(headers: Headers): number | null {
  const raw = headers.get("x-ch-autocut") ?? process.env.CH_AUTOCUT_CHARS;
  if (!raw || raw === "off") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

interface FrameMeta {
  raw: string;
  type: string;
  json: Record<string, any> | undefined;
}

/** Split one raw SSE frame's data payload and parse it as JSON. */
function frameMeta(raw: string): FrameMeta {
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
  }
  let json: Record<string, any> | undefined;
  try {
    json = data ? JSON.parse(data) : undefined;
  } catch {
    json = undefined;
  }
  return { raw, type: typeof json?.type === "string" ? json.type : "", json };
}

/** String payload carried by *.delta frames (text, reasoning, tool args). */
function deltaLen(j: Record<string, any> | undefined): number {
  if (!j) return 0;
  const s = j.delta ?? j.arguments ?? j.text;
  return typeof s === "string" ? s.length : 0;
}

const AUTOCUT_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

/**
 * Boundary-aware auto-cut variant of streamThrough. Forwards frames unchanged
 * while counting delivered delta chars; once past `cutAt` it waits for a safe
 * boundary (no open item, or an open message item — text truncates cleanly),
 * cancels the upstream read mid-generation, then synthesizes a well-formed
 * response.completed so the client sees a normal finished turn carrying every
 * fully delivered item. Terminal frames arriving first pass through untouched
 * (billing is already committed by then; there is nothing left to dodge).
 */
function streamThroughAutoCut(ctx: ProviderContext, res: Response, acc: Account, wire: string, cutAt: number): Response {
  const scanner = new SseScanner();
  const headers = downstreamHeaders(res.headers);
  const servedHeader = res.headers.get("openai-model") ?? undefined;
  if (servedHeader) headers.set("openai-model", ctx.requestedModel);
  const unsafeAsyncPullCancel = isBunAsyncPullCancelUnsafe();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let firstByteAt: number | undefined;
  let done = false;
  let readPending = false;
  let cancelRequested = false;
  let cancelReason: unknown;
  let readerCancel: Promise<void> | undefined;
  let cutFired = false;

  // --- auto-cut stream state ---
  let buf = "";
  let delivered = 0;
  let pendingCut = false;
  let terminalSeen = false;
  let seq = 0;
  let skeleton: Record<string, any> | undefined;
  const items: Record<string, any>[] = [];
  let openItem: { kind: string; id: string; index: number; text: string } | null = null;

  const cancelReader = (reason?: unknown): Promise<void> => {
    if (!readerCancel) {
      readerCancel = unsafeAsyncPullCancel
        ? Promise.resolve().then(() => reader.cancel(reason)).catch(() => {})
        : reader.cancel(reason).catch(() => {});
    }
    return readerCancel;
  };

  const finish = (error?: string) => {
    if (done) return;
    done = true;
    if (scanner.quotaFailure) {
      const ms = cooldownMs(undefined, scanner.failedError);
      coolDown(acc.id, "*", ms, scanner.failedCode!);
      log.warn(`chatgpt in-stream ${scanner.failedCode} acct=${acc.id} cooldown ${Math.round(ms / 1000)}s`);
    }
    const first = scanner.firstDeltaAt ?? firstByteAt;
    const cancelled = (cancelRequested || ctx.signal.aborted) && !scanner.completed && !cutFired;
    const err = cutFired
      ? `autocut at ${delivered} chars`
      : cancelled
        ? "client cancelled"
        : (scanner.completed && error === "client cancelled" ? undefined : error) ?? (scanner.failedCode ? `${scanner.failedCode}${scanner.failedMessage ? `: ${scanner.failedMessage}` : ""}` : undefined);
    const anomaly = scanner.model && !isServedModel(wire, scanner.model) ? scanner.model : undefined;
    const servedModel = anomaly ?? servedHeader ?? scanner.model ?? wire;
    if (anomaly) log.warn(`chatgpt upstream served ${servedModel} for requested ${wire} acct=${acc.id}`);
    if (cutFired) log.info(`chatgpt autocut acct=${acc.id} model=${servedModel} chars=${delivered}`);
    ctx.finish({
      accountId: acc.id,
      servedModel,
      status: cancelled ? 499 : res.status,
      usage: scanner.usage,
      firstTokenMs: first !== undefined ? first - ctx.startedAt : undefined,
      ...(err ? { error: redact(err) } : {}),
    });
  };

  if (!res.body) {
    finish();
    return new Response(null, { status: res.status, headers });
  }
  const reader = res.body.getReader();

  const track = (m: FrameMeta) => {
    const j = m.json;
    if (!j) return;
    if (typeof j.sequence_number === "number") seq = Math.max(seq, j.sequence_number);
    if (m.type === "response.created") {
      if (j.response && typeof j.response === "object") skeleton = j.response;
    } else if (m.type === "response.output_item.added") {
      openItem = {
        kind: typeof j.item?.type === "string" ? j.item.type : "unknown",
        id: typeof j.item?.id === "string" ? j.item.id : `item_${seq}`,
        index: typeof j.output_index === "number" ? j.output_index : items.length,
        text: "",
      };
    } else if (m.type === "response.output_text.delta") {
      if (openItem?.kind === "message") openItem.text += typeof j.delta === "string" ? j.delta : "";
    } else if (m.type === "response.output_item.done") {
      if (j.item && typeof j.item === "object") items.push(j.item);
      openItem = null;
    }
    if (m.type.endsWith(".delta")) delivered += deltaLen(j);
    if (AUTOCUT_TERMINAL.has(m.type)) terminalSeen = true;
  };

  const ev = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`;

  /** Emit the synthesized tail: close any open message item, marker note, completed. */
  const synthesizeClose = (): string => {
    const note = `\n\n[autocut: stream severed mid-generation at ${delivered} chars — reply "continue" to resume]`;
    let out = "";
    if (openItem?.kind === "message") {
      const text = openItem.text + note;
      const oi = openItem.index;
      const iid = openItem.id;
      out +=
        ev("response.output_text.delta", { item_id: iid, output_index: oi, content_index: 0, delta: note }) +
        ev("response.output_text.done", { item_id: iid, output_index: oi, content_index: 0, text }) +
        ev("response.content_part.done", {
          item_id: iid, output_index: oi, content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        });
      const item = {
        id: iid, type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      out += ev("response.output_item.done", { output_index: oi, item });
      items.push(item);
      openItem = null;
    } else {
      const oi = items.length;
      const iid = `msg_autocut_${seq}`;
      const item = {
        id: iid, type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: note.trim(), annotations: [] }],
      };
      out +=
        ev("response.output_item.added", {
          output_index: oi,
          item: { id: iid, type: "message", status: "in_progress", role: "assistant", content: [] },
        }) +
        ev("response.content_part.added", {
          item_id: iid, output_index: oi, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }) +
        ev("response.output_text.delta", { item_id: iid, output_index: oi, content_index: 0, delta: note.trim() }) +
        ev("response.output_text.done", { item_id: iid, output_index: oi, content_index: 0, text: note.trim() }) +
        ev("response.content_part.done", {
          item_id: iid, output_index: oi, content_index: 0,
          part: { type: "output_text", text: note.trim(), annotations: [] },
        }) +
        ev("response.output_item.done", { output_index: oi, item });
      items.push(item);
    }
    const est = Math.round(delivered / 4);
    const response = {
      ...(skeleton ?? {}),
      id: skeleton?.id ?? "resp_autocut",
      object: "response",
      status: "completed",
      model: skeleton?.model ?? wire,
      output: items,
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: est,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: est,
      },
    };
    out += ev("response.completed", { response });
    return out;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelRequested) return;
      readPending = true;
      try {
        const { value, done: eof } = await reader.read();
        readPending = false;
        if (cancelRequested || ctx.signal.aborted) {
          await cancelReader(cancelReason);
          finish("client cancelled");
          return;
        }
        if (eof) {
          if (buf) controller.enqueue(encoder.encode(buf));
          scanner.end();
          finish(scanner.completed || scanner.failedCode ? undefined : "stream ended without response.completed");
          controller.close();
          return;
        }
        if (value?.byteLength) {
          firstByteAt ??= Date.now();
          scanner.push(value);
          buf += decoder.decode(value, { stream: true });
          let out = "";
          let nl;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, nl + 2);
            buf = buf.slice(nl + 2);
            out += raw;
            const m = frameMeta(raw);
            track(m);
            if (!cutFired && !terminalSeen) {
              if (!pendingCut && delivered >= cutAt) pendingCut = true;
              if (pendingCut && (openItem === null || openItem.kind === "message")) {
                out += synthesizeClose();
                cutFired = true;
                break;
              }
            }
          }
          if (out) controller.enqueue(encoder.encode(out));
          if (cutFired) {
            controller.close();
            await cancelReader("autocut");
            finish();
            return;
          }
        }
      } catch (err) {
        readPending = false;
        if (cancelRequested || ctx.signal.aborted) {
          await cancelReader(cancelReason);
          finish("client cancelled");
          return;
        }
        finish(`stream error: ${err instanceof Error ? err.message : String(err)}`);
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelRequested = true;
      cancelReason = reason;
      finish("client cancelled");
      if (readPending) return Promise.resolve();
      return cancelReader(reason);
    },
  });
  return new Response(stream, { status: res.status, headers });
}

async function compact(ctx: ProviderContext): Promise<Response> {
  const wire = chatgptWireModel(ctx.model);
  // Same as the Codex CLI: the compact endpoint takes the raw body minus `reasoning`.
  const { reasoning: _r, ...rest } = ctx.body;
  const bodyText = JSON.stringify({ ...rest, model: wire });
  const d = await dispatch(ctx, COMPACT_URL, bodyText, "application/json");
  if (!d.ok) {
    ctx.finish(d.outcome);
    return d.response;
  }
  const { res, account } = d;
  const mismatch = reportedMismatch(ctx, res, account.id, wire);
  if (mismatch) return mismatch;
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.finish({ accountId: account.id, servedModel: wire, status: 502, error: redact(msg) });
    return jsonError(502, `compact response failed: ${redact(msg)}`);
  }
  let usage;
  let bodyModel: string | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    usage = usageFromResponses(parsed?.usage);
    if (typeof parsed?.model === "string") bodyModel = parsed.model;
  } catch {
    /* non-JSON body: pass through anyway */
  }
  if (bodyModel && !isServedModel(wire, bodyModel)) {
    ctx.finish({ accountId: account.id, servedModel: bodyModel, status: 502, error: `upstream reported model ${bodyModel}` });
    return jsonError(502, "Upstream did not serve the requested model.", "model_mismatch");
  }
  ctx.finish({
    accountId: account.id,
    servedModel: bodyModel ?? res.headers.get("openai-model") ?? wire,
    status: res.status,
    usage,
    firstTokenMs: Date.now() - ctx.startedAt,
  });
  const headers = downstreamHeaders(res.headers, "application/json");
  if (headers.has("openai-model")) headers.set("openai-model", ctx.requestedModel);
  return new Response(bytes, { status: res.status, headers });
}

/** Codex image tool (generate/edit): forward the raw body through a pooled account. */
export async function chatgptImages(ctx: ProviderContext, kind: "generations" | "edits", body: Uint8Array, contentType: string): Promise<Response> {
  const d = await dispatch(ctx, imagesUrl(kind), new Uint8Array(body), "application/json", contentType);
  if (!d.ok) {
    ctx.finish(d.outcome);
    return d.response;
  }
  const { res, account } = d;
  const bytes = await res.arrayBuffer();
  let usage;
  try {
    usage = usageFromResponses(JSON.parse(new TextDecoder().decode(bytes))?.usage);
  } catch {
    /* non-JSON: pass through */
  }
  ctx.finish({ accountId: account.id, servedModel: ctx.model, status: res.status, usage, firstTokenMs: Date.now() - ctx.startedAt });
  return new Response(bytes, { status: res.status, headers: downstreamHeaders(res.headers, "application/json") });
}

async function refreshQuota(account: Account): Promise<void> {
  let cred = await ensureFreshCredential(account);
  let res = await fetchWhamUsage(cred.accessToken, cred.chatgptAccountId);
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    cred = await refreshAfterUnauthorized(account, cred.accessToken);
    res = await fetchWhamUsage(cred.accessToken, cred.chatgptAccountId);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) setStatus(account.id, "needs_reauth", "usage endpoint 401 after refresh");
    throw new Error(`ChatGPT usage request failed: HTTP ${res.status}`);
  }
  const q = parseWhamUsage(await res.json());
  mergeQuota(account.id, q);
  if (q.plan && q.plan !== account.meta.plan) patchMeta(account.id, { plan: q.plan });
}

export const chatgptProvider: Provider = {
  id: "chatgpt",
  handle,
  compact,
  async models() {
    return chatgptCatalogModels();
  },
  login: chatgptLogin,
  refreshQuota,
};
