// Public share endpoint: remote Codex users call ChatGPT with their own login through us.
// Binds 127.0.0.1 only; a tunnel (Tailscale Funnel / cloudflared) exposes it. No GUI, no /api.

import { COMPACT_URL, RESPONSES_URL, SseScanner, buildUpstreamHeaders, downstreamHeaders, imagesUrl, isServedModel, upstreamBody, usageFromResponses } from "../providers/chatgpt/upstream.ts";
import { buildChatgptCatalog, chatgptWireModel } from "../providers/chatgpt/catalog.ts";
import { isBunAsyncPullCancelUnsafe } from "../lib/bun-stream-caps.ts";
import { imageModelOf, readBody, readBodyBytes } from "../lib/body.ts";
import { jsonError } from "../lib/sse.ts";
import { resolveAlias } from "../store/modelmap.ts";
import { log, redact } from "../lib/log.ts";
import { InputAudit } from "../lib/input-audit.ts";
import { getSetting } from "../store/db.ts";
import { route, sessionKeyFrom } from "../router.ts";
import { recordUsage } from "../usage.ts";
import { parseQuotaHeaders } from "../providers/chatgpt/quota.ts";
import { clientInfo, recordQuotaSample, recordShareEvent, saveShareQuota } from "./telemetry.ts";
import { bearerToken, verifyChatgptToken, type TokenIdentity } from "./auth.ts";
import { buildShareCatalog } from "./catalog.ts";
import { POLICY } from "./policy.ts";
import { pinnedFetch } from "../net/pin.ts";
import { KEEPALIVE, SseRewriter, sanitizeText } from "./sanitize.ts";
import { isCompactionTrigger } from "../compaction.ts";
import { injectAdditionalToolPad, injectArgsPad, injectArgsPadSoft, injectJsonLane, injectPadCall, learnReservedTool, mainEffortClamp, markerInstruction, markerUserNote, pickCollabWire, pickLightWire, sentinelInstruction, shareAutoCutChars, shareAutoCutStream, shareJsonLaneEnabled, slimMode, slimAstraInstruction, slimMarkerInstruction, stripClientMeta, cleanToolOutputs, stripReasoningItems, toolPadInstruction, trimToolOutputs } from "./autocut.ts";
import { reqCacheGet, reqCacheKey, reqCacheTap, reqCacheTtlMs } from "../lib/reqcache.ts";
import { getShareUser, isShareUserExpired, shareAccountId, shareAllowlistActive, touchShareUser } from "./users.ts";
import type { RequestOutcome, ResponsesRequest, Usage } from "../types.ts";

let KEEPALIVE_MS = 15_000;
let UPSTREAM_ERROR_READ_MS = 3_000;
export function setUpstreamErrorReadMsForTests(ms: number): void { UPSTREAM_ERROR_READ_MS = ms; }

/** For tests. */
export function setKeepAliveMsForTests(ms: number): void {
  KEEPALIVE_MS = ms;
}
const MAX_CONCURRENT = 8;
const MAX_PER_MINUTE = 60;

// as control flow. A reason that settles on a promise nobody is still
// awaiting surfaces as an unhandled rejection — routine, never fatal. Guard
// the process: log it, keep serving. (Observed kill: Bun exits on a stray
const CANCEL_REASON_RE = /^(autocut|client-abort|downstream-stalled|upstream error)/;
process.on("unhandledRejection", (reason) => {
  const s = String(reason instanceof Error ? reason.message : reason);
  if (CANCEL_REASON_RE.test(s)) { log.info(`share stray cancel reason=${s}`); return; }
  log.error(`unhandled rejection: ${s}`);
});
// Upstream connect+headers can hang silently (edge queue, half-open socket):
// bound each attempt so the retry loop actually engages before the client
// gives up.
const UPSTREAM_HDR_MS = () =>
  Number(process.env.CH_UPSTREAM_HDR_MS ?? POLICY.limits.upstreamHdrMs ?? 20_000);
/** Upstream headers worth passing on: quota/reset info Codex shows in its status line. */
const QUOTA_HEADER_RE = /^(retry-after|x-codex-.*)$/i;

// ---------------------------------------------------------------------------
// auth + per-user limits
// ---------------------------------------------------------------------------

type Gate = { ok: true; identity: TokenIdentity } | { ok: false; response: Response };

// Optional allowlist: once the operator adds rows via `ch-relay allow add`,
// only those ChatGPT emails are served; an empty table stays open.
async function authorize(req: Request, opts: { allowExpired?: boolean } = {}): Promise<Gate> {
  const v = await verifyChatgptToken(bearerToken(req.headers), opts);
  if (!v.ok) {
    if (v.reason === "jwks_unavailable") return { ok: false, response: jsonError(503, "Auth keys unavailable, try again shortly.", "auth_unavailable") };
    // 401 makes Codex refresh its ChatGPT token and retry.
    const msg = v.reason === "expired" ? "Access token expired." : "Sign in to Codex with ChatGPT to use this server.";
    return { ok: false, response: jsonError(401, msg, v.reason === "expired" ? "token_expired" : "invalid_token") };
  }
  if (shareAllowlistActive()) {
    const u = getShareUser(v.identity.email);
    if (!u || !u.enabled || isShareUserExpired(u)) {
      return { ok: false, response: jsonError(403, "This ChatGPT account isn't enrolled on this server.", "not_enrolled") };
    }
  }
  touchShareUser(v.identity.email); // no-op for unknown emails; keeps usage stats
  return { ok: true, identity: v.identity };
}

const active = new Map<string, number>();
const recent = new Map<string, number[]>();
/** Circuit breaker: when a mutated upstream request ends in a failure, stop
 *  injecting mutations for that user briefly — client retries then run the
 *  plain body instead of amplifying a poisoned/failing path. */
const failBreaker = new Map<string, number>();
const BREAKER_MS = 90_000;

/** Returns a release function, or null when the user is over their limits. */
function acquire(email: string): (() => void) | null {
  const now = Date.now();
  const hits = (recent.get(email) ?? []).filter((t) => now - t < 60_000);
  if ((active.get(email) ?? 0) >= MAX_CONCURRENT || hits.length >= MAX_PER_MINUTE) return null;
  hits.push(now);
  recent.set(email, hits);
  active.set(email, (active.get(email) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.set(email, Math.max(0, (active.get(email) ?? 1) - 1));
  };
}

// ---------------------------------------------------------------------------
// data plane
// ---------------------------------------------------------------------------

function clientHeaders(upstream: Headers, requestedModel: string, defaultType: string): Headers {
  const h = downstreamHeaders(upstream, defaultType);
  // Codex raises model/rerouted when openai-model differs from the slug it asked for.
  if (h.has("openai-model")) h.set("openai-model", requestedModel);
  return h;
}

function errorResponse(res: Response, text: string): Response {
  const h = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
  res.headers.forEach((v, k) => {
    if (QUOTA_HEADER_RE.test(k)) h.set(k, v);
  });
  return new Response(sanitizeText(text), { status: res.status, headers: h });
}

/**
 * Slugs a share client may send. Only published catalog aliases plus the bare
 * Auto Review spellings (Codex issues internal auto-review calls with the real
 * slug). Bare wire ids are rejected: serving them would let a misconfigured or
 * hand-edited client run a different model than the catalog shows.
 */
function allowedShareModels(): Set<string> {
  const s = new Set(buildShareCatalog().models.map((m) => String(m.slug)));
  s.add("codex-auto-review");
  s.add("openai/codex-auto-review");
  return s;
}

/**
 * Also accept any other stored alias of a published model (several aliases can map to one
 * wire model, e.g. after importing another server's alias table so old threads keep working).
 * Bare wire ids still have no alias row, so they stay rejected.
 */
function isAllowedShareModel(slug: string): boolean {
  const allowed = allowedShareModels();
  if (allowed.has(slug)) return true;
  const a = resolveAlias(slug);
  if (!a || a.provider !== "chatgpt") return false;
  // Packaged relay: a stored alias is already vetted — accept it even when its
  // wire is now hidden in the published catalog (e.g. gpt-reserve), so threads
  // configured on hidden/reserve models don't 404. Bare wire ids have no alias
  // row and stay rejected.
  const target = chatgptWireModel(a.wire);
  for (const s of allowed) {
    if (chatgptWireModel(s) === target) return true;
  }
  for (const m of buildChatgptCatalog()) {
    if (chatgptWireModel(String(m.slug)) === target) return true;
  }
  return false;
}

async function handleResponses(req: Request, compact: boolean, identity: TokenIdentity): Promise<Response> {
  const started = Date.now();
  const rawText = await readBody(req);
  let body: ResponsesRequest;
  try {
    body = JSON.parse(rawText) as ResponsesRequest;
  } catch (err) {
    return jsonError(400, `invalid request body: ${err instanceof Error ? err.message : String(err)}`, "invalid_request_error");
  }
  if (!body?.model) return jsonError(400, "missing model", "invalid_request_error");
  const r = route(body.model);
  // Other providers run on the owner's pooled accounts: never reachable from here.
  if (r.provider !== "chatgpt" || !isAllowedShareModel(body.model))
    return jsonError(404, `model ${body.model} is not available`, "model_not_found");

  // Replay cache: identical retried bodies skip upstream entirely. Checked
  // before acquire() so a hit never leaks a concurrency slot.
  const cacheKey =
    !compact && body.stream === true && reqCacheTtlMs() > 0
      ? reqCacheKey("share", rawText, bearerToken(req.headers))
      : null;
  if (cacheKey) {
    const hit = reqCacheGet(cacheKey);
    if (hit) {
      log.info(`share cache hit user=${identity.email} model=${body.model}`);
      return hit;
    }
  }

  const release = acquire(identity.email);
  if (!release) {
    recordShareEvent("rate_limited", identity.email, clientInfo(req.headers).ipHash);
    return jsonError(429, "Too many requests from this account, slow down.", "rate_limited");
  }

  let wire = chatgptWireModel(r.model);
  const requestedModel = body.model;
  const effort = body.reasoning?.effort ?? undefined;
  const inputAudit = new InputAudit(compact ? "share_compact" : "share", wire);
  let finished = false;
  let mutated = false;
  let ttfbMs = -1;
  const ci = clientInfo(req.headers, { sessionKey: sessionKeyFrom(req.headers, body) });
  const finish = (o: RequestOutcome) => {
    if (finished) return;
    finished = true;
    inputAudit.finish(o);
    // Breaker opens ONLY on upstream content rejection of the mutated body
    // (400/422 or explicit invalid/schema errors). Socket drops, timeouts,
    // 499/429 and rate limits are ambient — they would fail a plain body
    // too, so tripping the breaker on them just burns savings for 90s.
    if (
      mutated &&
      (o.status === 400 || o.status === 422 || /invalid|schema|param|malformed|unsupported/i.test(o.error ?? ""))
    ) {
      failBreaker.set(identity.email, Date.now() + BREAKER_MS);
      log.info(`share breaker open for ${identity.email} (${(o.error ?? "").slice(0, 80)})`);
    }
    release();
    try {
      recordUsage({ ...o, provider: "chatgpt", requestedModel, effort, startedAt: started, ...ci });
    } catch (err) {
      log.error("usage record failed", String(err));
    }
    const u = o.usage;
    log.info(
      `share ${o.status} ${requestedModel} user=${identity.email} ${Date.now() - started}ms ttfb=${ttfbMs}ms` +
        // eof is the neutral end — when the request never got a mutated body
        // the bypass reason matters more than the ending.
        ` cut=${o.cut === "eof" && pathNote !== "auto" ? pathNote : (o.cut ?? pathNote)}` +
        (u ? ` in=${u.inputTokens} cached=${u.cachedInputTokens ?? 0} out=${u.outputTokens}` : "") +
        (o.error ? ` err=${redact(o.error)}` : ""),
    );
  };
  const accountId = shareAccountId(identity.email);

  let upstreamText: string;
  let parsedBase: Record<string, any> | undefined;
  if (compact) {
    const { reasoning: _r, parallel_tool_calls: _p, ...rest } = body;
    upstreamText = JSON.stringify({ ...rest, model: wire });
  } else {
    parsedBase = upstreamBody(body, wire, req.headers) as Record<string, any>;
    // Ask upstream for visible reasoning summaries so the client shows
    // progress during long thinking instead of a bare spinner. No-op when the
    // client already picked a summary mode; never fabricates a reasoning
    // block on requests that didn't send one.
    if (
      parsedBase.reasoning &&
      typeof parsedBase.reasoning === "object" &&
      parsedBase.reasoning.summary === undefined
    ) {
      parsedBase.reasoning = { ...parsedBase.reasoning, summary: "auto" };
    }
    // Optional main-turn effort ceiling (CH_SHARE_EFFORT) — reasoning is the
    // largest output component at ultra/max; clamping is a quality trade-off
    // the operator opts into. Never raises the requested level.
    const effClamped = mainEffortClamp(parsedBase);
    if (effClamped) log.info(`share effortclamp ${effClamped} model=${wire}`);
    // Shorten stale tool text; measure content separately from reported usage.
    inputAudit.capture("before", parsedBase);
    const trimmed = trimToolOutputs(parsedBase);
    const cleaned = process.env.CH_CLEAN_OUTPUTS === "0" ? 0 : cleanToolOutputs(parsedBase);
    inputAudit.capture("inputtrim", parsedBase);
    if (trimmed || cleaned) log.info(`share inputtrim items=${trimmed} clean=${cleaned} model=${wire}`);
    // Optional stale-reasoning strip (CH_STRIP_REASONING) — reasoning items
    // are ~30% of large bodies and optional context, not required state.
    const rstrip = stripReasoningItems(parsedBase);
    if (rstrip) log.info(`share reasonstrip items=${rstrip} model=${wire}`);
    // Optional light-model reroute for trivial tool-free traffic, then for
    // collab-continuation turns (newest item = collab tool output).
    const lw = pickLightWire(parsedBase) ?? pickCollabWire(parsedBase);
    if (lw) { parsedBase.model = lw; wire = lw; log.info(`share lightwire ->${lw} model=${body.model}`); }
    upstreamText = JSON.stringify(parsedBase);
  }
  const autoChars = !compact && !isCompactionTrigger(body) && body.stream === true ? shareAutoCutChars(req.headers) : null;
  let pathNote = compact
    ? "compact"
    : isCompactionTrigger(body)
      ? "trigger"
      : body.stream !== true
        ? "nostream"
        : autoChars === null
          ? "off"
          : "auto";
  let autocutBody: Record<string, any> | undefined;
  let markerOnlyText: string | undefined;
  let softText: string | undefined;
  let softCodePad: Set<string> | undefined;
  let jsonLane = false;
  let padRequired: Record<string, string[]> | undefined;
  let codePad: Set<string> | undefined;
  let aliasOf: Record<string, string> | undefined;
  let softPadRequired: Record<string, string[]> | undefined;
  let softAliasOf: Record<string, string> | undefined;
  let plainText: string | undefined;
  if (autoChars) {
    plainText = upstreamText;
    const parsed = (parsedBase ?? JSON.parse(upstreamText)) as Record<string, any>;
    const broken = (failBreaker.get(identity.email) ?? 0) > Date.now();
    if (broken) pathNote = "breaker";
    if (!broken) {
      mutated = true;
      const isAstra = wire.startsWith("gpt-6-astra");
      const clientFormat = parsed.text?.format != null;
      // A client-owned format cannot carry a proxy text trailer. Tool argument
      if (!clientFormat) {
        const inj = isAstra
          ? (slimMode() ? slimAstraInstruction() : `${toolPadInstruction()}\n\n${sentinelInstruction()}`)
          : (slimMode() ? slimMarkerInstruction() : markerInstruction());
        const instr = (parsed.instructions as string) ?? "";
        if (instr.trim()) {
          parsed.instructions = `${instr}\n\n${inj}`;
        } else if (Array.isArray(parsed.input)) {
          // instructions channel — deliver them as a developer input message.
          parsed.input = [
            ...(parsed.input as any[]),
            { type: "message", role: "developer", content: [{ type: "input_text", text: inj }] },
          ];
        } else {
          parsed.instructions = inj;
        }
      }
      if (!clientFormat && !isAstra && !slimMode() && Array.isArray(parsed.input)) {
        parsed.input = [
          ...parsed.input,
          { type: "message", role: "user", content: [{ type: "input_text", text: markerUserNote() }] },
        ];
      }
      if (!clientFormat && !isAstra && !slimMode()) injectPadCall(parsed);
      markerOnlyText = JSON.stringify(parsed);
      // middle fallback that survives strict-schema rejections.
      if (!slimMode()) {
        const softParsed = JSON.parse(markerOnlyText) as Record<string, any>;
        const sp = injectArgsPadSoft(softParsed);
        const scp = injectAdditionalToolPad(softParsed) ?? undefined;
        if (sp || scp) {
          softText = JSON.stringify(softParsed);
          softCodePad = scp?.codePad;
          softPadRequired = scp?.padRequired;
          softAliasOf = scp?.aliasOf;
        }
      }
      if (Array.isArray(parsed.tools) && parsed.tools.length) {
        padRequired = {};
        for (const t of parsed.tools) {
          if (t?.type === "function") {
            padRequired[String(t.name)] = Array.isArray(t.parameters?.required)
              ? [...t.parameters.required]
              : [];
          }
        }
        injectArgsPad(parsed, { descHints: !slimMode() });
      }
      // Desktop declares tools inside `additional_tools` input items — strict
      const cp = injectAdditionalToolPad(parsed, { descHints: !slimMode() });
      if (cp) {
        codePad = cp.codePad;
        padRequired = { ...padRequired, ...cp.padRequired };
        aliasOf = cp.aliasOf;
      }
      // Last mutation: pin text output to {"answer","notes"} so a text-only
      // turn keeps generating after the real answer — the stream cuts at the
      // answer's closing quote. The 400 fallback stays schema-free. Astra is
      if (!isAstra && !slimMode() && shareJsonLaneEnabled() && injectJsonLane(parsed)) {
        jsonLane = true;
      }
      inputAudit.capture("injected", parsed);
      const strippedMeta = process.env.CH_METATRIM === "0" ? 0 : stripClientMeta(parsed);
      inputAudit.capture("metatrim", parsed);
      if (strippedMeta) log.info(`share metatrim fields=${strippedMeta} model=${wire}`);
      upstreamText = JSON.stringify(parsed);
    }
    if (Array.isArray(parsed.tools) && parsed.tools.length) {
      log.info(`share tools: ${parsed.tools.map((t: any) => t?.type ?? "?").join(",")} model=${wire}`);
    }

    autocutBody = parsed;
  }
  const token = bearerToken(req.headers)!;
  const accountHeader = req.headers.get("chatgpt-account-id") ?? identity.chatgptAccountId;

  // Upstream regularly refuses fresh connections under load ("The connection
  // was closed") — that is transient, not a rejection, so retry before
  // surfacing a 502 that the client reports as a reconnect.
  const upstreamFetch = async (url: string, bodyText: string, accept: string, extraSignal?: AbortSignal): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      // response body in fetch, so firing it after resolve would sever a
      // healthy stream. Clear on resolve instead.
      const ac = new AbortController();
      const hdrTimer = setTimeout(() => ac.abort(new Error("upstream headers timeout")), UPSTREAM_HDR_MS());
      const signal = AbortSignal.any(extraSignal ? [req.signal, extraSignal, ac.signal] : [req.signal, ac.signal]);
      try {
        inputAudit.sent(bodyText);
        const res = await pinnedFetch(url, {
          method: "POST",
          headers: buildUpstreamHeaders(req.headers, token, accountHeader ?? undefined, accept),
          body: bodyText,
          signal,
        });
        clearTimeout(hdrTimer);
        return res;
      } catch (err) {
        clearTimeout(hdrTimer);
        lastErr = err;
        if (req.signal.aborted || extraSignal?.aborted || attempt === 2) throw err;
        log.info(`share upstream connect retry ${attempt + 1} user=${identity.email} err=${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  let firstSegment = new AbortController();
  const errorBodies = new WeakMap<Response, string>();
  const readErrorBody = async (response: Response): Promise<string> => {
    if (errorBodies.has(response)) return errorBodies.get(response)!;
    if (!response.body) return "";
    const segment = firstSegment;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let pending: ReturnType<typeof reader.read> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      await Promise.race([
        (async () => {
          while (bytes < 64 * 1024 && !segment.signal.aborted) {
            const chunk = await (pending = reader.read());
            if (chunk.done) break;
            const value = chunk.value.subarray(0, 64 * 1024 - bytes);
            text += decoder.decode(value, { stream: true });
            bytes += value.byteLength;
          }
        })(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, UPSTREAM_ERROR_READ_MS); }),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch { /* keep the diagnostic prefix already received */ }
    finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      segment.abort("upstream error body consumed or timed out");
      const cancel = () => { void reader.cancel().catch(() => {}); };
      if (isBunAsyncPullCancelUnsafe() && pending) void pending.then(cancel, cancel);
      else cancel();
    }
    text += decoder.decode();
    errorBodies.set(response, text);
    return text;
  };

  let res: Response;
  try {
    res = await upstreamFetch(compact ? COMPACT_URL : RESPONSES_URL, upstreamText, compact ? "application/json" : "text/event-stream", firstSegment.signal);
    ttfbMs = Date.now() - started;
  } catch (err) {
    const msg = req.signal.aborted ? "client cancelled" : `network error: ${err instanceof Error ? err.message : String(err)}`;
    finish({ accountId, servedModel: wire, status: req.signal.aborted ? 499 : 502, error: msg });
    return jsonError(502, "Upstream unreachable, try again.", "upstream_unreachable");
  }

  for (let fb of [softText, markerOnlyText]) {
    if (!fb || res.ok || res.status !== 400) continue;
    const errText = await readErrorBody(res);
    log.info(`share upstream reject status=${res.status} model=${wire} err=${errText.replace(/\s+/g, " ").slice(0, 500)}`);
    const learned = learnReservedTool(errText);
    if (learned.length) {
      log.info(`share reserved tool learned: ${learned.join(",")} model=${wire}`);
      // Regenerate the soft tier without the just-locked schema so this
      if (fb === softText && markerOnlyText) {
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
    }
    try {
      firstSegment.abort("upstream rejected injected body");
      firstSegment = new AbortController();
      res = await upstreamFetch(RESPONSES_URL, fb, "text/event-stream", firstSegment.signal);
    } catch (err) {
      const msg = req.signal.aborted ? "client cancelled" : `network error: ${err instanceof Error ? err.message : String(err)}`;
      finish({ accountId, servedModel: wire, status: req.signal.aborted ? 499 : 502, error: msg });
      return jsonError(502, "Upstream unreachable, try again.", "upstream_unreachable");
    }
    if (!res.ok) continue;
    autocutBody = JSON.parse(fb) as Record<string, any>;
    jsonLane = false; // fallback bodies have no text.format — plain stream ahead
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

  if (!res.ok) {
    const text = await readErrorBody(res);
    finish({ accountId, servedModel: res.headers.get("openai-model") ?? wire, status: res.status, error: redact(text || `HTTP ${res.status}`) });
    return errorResponse(res, text);
  }

  // Selection integrity: if upstream reports a different model up front, fail loud
  // instead of streaming another model's output under the requested name.
  const reportedModel = res.headers.get("openai-model");
  if (reportedModel && !isServedModel(wire, reportedModel)) {
    firstSegment.abort("upstream model mismatch");
    void res.body?.cancel().catch(() => {});
    finish({ accountId, servedModel: reportedModel, status: 502, error: `upstream reported model ${reportedModel}` });
    return jsonError(502, "Upstream did not serve the requested model.", "model_mismatch");
  }

  // Quota headers ride every upstream response — keep the user's last reading
  // and append it to the sample series for per-request meter-cost analysis.
  try {
    const q = parseQuotaHeaders(res.headers);
    if (q) {
      saveShareQuota(identity.email, q);
      recordQuotaSample(identity.email, q, "hdr");
    }
  } catch {
    /* telemetry must never fail a request */
  }

  if (compact) {
    const text = await res.text().catch(() => "");
    let usage: Usage | undefined;
    let bodyModel: string | undefined;
    try {
      const parsed = JSON.parse(text);
      usage = usageFromResponses(parsed?.usage);
      if (typeof parsed?.model === "string") bodyModel = parsed.model;
    } catch {
      /* non-JSON: pass through */
    }
    if (bodyModel && !isServedModel(wire, bodyModel)) {
      finish({ accountId, servedModel: bodyModel, status: 502, error: `upstream reported model ${bodyModel}` });
      return jsonError(502, "Upstream did not serve the requested model.", "model_mismatch");
    }
    finish({ accountId, servedModel: bodyModel ?? reportedModel ?? wire, status: res.status, usage, firstTokenMs: Date.now() - started });
    return new Response(sanitizeText(text), { status: res.status, headers: clientHeaders(res.headers, requestedModel, "application/json") });
  }

  if (autoChars && autocutBody && res.body) {
    // Bound the recovery POST: without a timeout a hung upstream fetch parks
    // the stream with no keepalives until the client watchdog kills it.
    const fetchSeg = (bodyText: string, signal?: AbortSignal) =>
      upstreamFetch(RESPONSES_URL, bodyText, "text/event-stream", signal);
    return reqCacheTap(
      new Response(
        shareAutoCutStream({
          cutAt: autoChars,
          wire,
          requestedModel,
          signal: req.signal,
          started,
          first: res,
          fetchSeg,
          abortFirst: (reason) => firstSegment.abort(reason),
          origBody: autocutBody,
          // Skip the recovery retry when the body was never mutated: retrying
          // the identical plain body just doubles the upstream bill for the
          // same guaranteed failure.
          plainBody: mutated ? plainText : undefined,
          // Softer bodies retried before plainBody when the strict/mutated
          // request fails in-stream (upstream surfaces some schema rejections
          // as 200-stream `error`/`response.failed` frames, not HTTP 400s).
          // Skip bodies byte-identical to the one that just failed — retrying
          // the same payload burns an upstream call and can never succeed.
          retryBodies: mutated
            ? [softText, markerOnlyText].filter((b): b is string => !!b && b !== upstreamText)
            : undefined,
          cleanEcho: plainText ? (JSON.parse(plainText) as Record<string, any>) : undefined,
          jsonSchema: jsonLane,
          padRequired,
          codePad,
          aliasOf,
          done: (o) => finish({ accountId, ...o }),
        }),
        { status: res.status, headers: clientHeaders(res.headers, requestedModel, "text/event-stream") },
      ),
      cacheKey,
    );
  }

  if (pathNote === "auto") pathNote = "nobody";
  return reqCacheTap(
    new Response(
      rewriteStream(res, req.signal, wire, requestedModel, (o) => finish({ accountId, ...o }), started),
      { status: res.status, headers: clientHeaders(res.headers, requestedModel, "text/event-stream") },
    ),
    cacheKey,
  );
}

/** Codex image tool (generate/edit) with the user's own token; body forwarded as-is. */
async function handleImages(req: Request, kind: "generations" | "edits", identity: TokenIdentity): Promise<Response> {
  const started = Date.now();
  const contentType = req.headers.get("content-type") ?? "application/json";
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBytes(req);
  } catch (err) {
    return jsonError(400, `invalid request body: ${err instanceof Error ? err.message : String(err)}`, "invalid_request_error");
  }
  const release = acquire(identity.email);
  if (!release) return jsonError(429, "Too many requests from this account, slow down.", "rate_limited");
  const model = imageModelOf(bytes, contentType);
  const accountId = shareAccountId(identity.email);
  const finish = (o: Omit<RequestOutcome, "accountId" | "servedModel">) => {
    release();
    try {
      recordUsage({ ...o, accountId, servedModel: model, provider: "chatgpt", requestedModel: model, startedAt: started });
    } catch (err) {
      log.error("usage record failed", String(err));
    }
    log.info(`share ${o.status} images/${kind} user=${identity.email} ${Date.now() - started}ms` + (o.error ? ` err=${redact(o.error)}` : ""));
  };
  const upstreamToken = bearerToken(req.headers)!;
  const accountHeader = req.headers.get("chatgpt-account-id") ?? identity.chatgptAccountId;
  let res: Response;
  try {
    res = await fetch(imagesUrl(kind), {
      method: "POST",
      headers: buildUpstreamHeaders(req.headers, upstreamToken, accountHeader ?? undefined, "application/json", contentType),
      body: new Uint8Array(bytes),
      signal: req.signal,
    });
  } catch (err) {
    finish({ status: req.signal.aborted ? 499 : 502, error: err instanceof Error ? err.message : String(err) });
    return jsonError(502, "Upstream unreachable, try again.", "upstream_unreachable");
  }
  const body = await res.arrayBuffer();
  let usage: Usage | undefined;
  if (res.ok) {
    try {
      usage = usageFromResponses(JSON.parse(new TextDecoder().decode(body))?.usage);
    } catch {
      /* non-JSON: pass through */
    }
  }
  finish({ status: res.status, usage, ...(res.ok ? {} : { error: redact(new TextDecoder().decode(body).slice(0, 500)) }) });
  if (!res.ok) return errorResponse(res, new TextDecoder().decode(body));
  return new Response(body, { status: res.status, headers: downstreamHeaders(res.headers, "application/json") });
}

/** Upstream SSE -> client with wire ids rewritten and keep-alives while upstream is quiet. */
function rewriteStream(
  res: Response,
  signal: AbortSignal,
  wire: string,
  requestedModel: string,
  done: (o: Omit<RequestOutcome, "accountId">) => void,
  started: number,
): ReadableStream<Uint8Array> {
  const scanner = new SseScanner();
  const rewriter = new SseRewriter({ [wire]: requestedModel });
  const reader = res.body!.getReader();
  const unsafeAsyncPullCancel = isBunAsyncPullCancelUnsafe();
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  let pending: Promise<ReadResult> | null = null;
  let cancelled = false;
  let firstAt: number | undefined;

  const end = (error?: string) => {
    const aborted = cancelled || signal.aborted;
    const cancelledEarly = aborted && !scanner.completed;
    const err = cancelledEarly
      ? "client cancelled"
      : (scanner.completed && error === "client cancelled" ? undefined : error) ?? (scanner.failedCode ? `${scanner.failedCode}${scanner.failedMessage ? `: ${scanner.failedMessage}` : ""}` : undefined);
    // The header check already passed; a stream-reported model of another family
    // is post-hoc truth for the log — too late to undo, but must be recorded.
    const anomaly = scanner.model && !isServedModel(wire, scanner.model) ? scanner.model : undefined;
    const servedModel = anomaly ?? res.headers.get("openai-model") ?? scanner.model ?? wire;
    if (anomaly) log.warn(`share upstream served ${servedModel} for requested ${requestedModel}`);
    done({
      servedModel,
      status: cancelledEarly ? 499 : res.status,
      usage: scanner.usage,
      firstTokenMs: (scanner.firstDeltaAt ?? firstAt) !== undefined ? (scanner.firstDeltaAt ?? firstAt)! - started : undefined,
      ...(err ? { error: redact(err) } : {}),
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (cancelled) return;
        const read: Promise<ReadResult> = (pending ??= reader.read());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<"tick">((resolve) => (timer = setTimeout(() => resolve("tick"), KEEPALIVE_MS)));
        let r: ReadResult | "tick";
        try {
          r = await Promise.race([read, tick]);
        } catch (err) {
          pending = null;
          if (cancelled || signal.aborted) {
            end("client cancelled");
            return;
          }
          end(`stream error: ${err instanceof Error ? err.message : String(err)}`);
          controller.error(err);
          return;
        } finally {
          clearTimeout(timer);
        }
        if (r === "tick") {
          if (rewriter.atBoundary()) {
            controller.enqueue(KEEPALIVE);
            return;
          }
          continue;
        }
        pending = null;
        if (r.done) {
          scanner.end();
          const rest = rewriter.flush();
          if (rest.byteLength) controller.enqueue(rest);
          end(scanner.completed || scanner.failedCode ? undefined : "stream ended without response.completed");
          controller.close();
          return;
        }
        if (!r.value?.byteLength) continue;
        firstAt ??= Date.now();
        scanner.push(r.value);
        const out = rewriter.push(r.value);
        if (out.byteLength) {
          controller.enqueue(out);
          return;
        }
      }
    },
    cancel(reason) {
      cancelled = true;
      end("client cancelled");
      // Same Bun caveat as the pool path: don't cancel while a read() is still pending.
      if (pending && unsafeAsyncPullCancel) {
        pending.finally(() => reader.cancel(reason).catch(() => {})).catch(() => {});
        return;
      }
      return reader.cancel(reason).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// client setup
// ---------------------------------------------------------------------------

/** Public base URL: configured one, else what the tunnel forwarded us. */
export function publicBaseUrl(req?: Request): string | null {
  const configured = getSetting<string | null>("share.publicUrl", null);
  if (configured) return configured.replace(/\/+$/, "");
  if (!req) return null;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return null;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function catalogResponse() {
  const { models, defaultModel } = buildShareCatalog();
  return new Response(JSON.stringify({ models }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "x-default-model": defaultModel, "cache-control": "no-store" },
  });
}

async function clientCatalog(req: Request): Promise<Response> {
  const gate = await authorize(req, { allowExpired: true });
  if (!gate.ok) return gate.response;
  log.info(`share catalog -> ${gate.identity.email}`);
  return catalogResponse();
}

async function listModels(req: Request): Promise<Response> {
  const gate = await authorize(req);
  if (!gate.ok) return gate.response;
  const { models } = buildShareCatalog();
  return Response.json({
    object: "list",
    data: models.map((m) => ({
      id: m.slug,
      object: "model",
      created: 0,
      owned_by: "ch-relay",
      context_window: m.context_window,
      max_context_window: m.max_context_window,
      auto_compact_token_limit: m.auto_compact_token_limit,
    })),
  });
}

async function guardedImages(req: Request, kind: "generations" | "edits"): Promise<Response> {
  const gate = await authorize(req);
  if (!gate.ok) return gate.response;
  try {
    return await handleImages(req, kind, gate.identity);
  } catch (err) {
    log.error("share image request failed", redact(err instanceof Error ? err.message : String(err)));
    return jsonError(500, "internal error");
  }
}

async function guarded(req: Request, compact: boolean): Promise<Response> {
  const gate = await authorize(req);
  if (!gate.ok) return gate.response;
  try {
    return await handleResponses(req, compact, gate.identity);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("share request failed", redact(msg));
    return jsonError(500, "internal error");
  }
}

export function startShareServer(port: number, hostname = "127.0.0.1") {
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    routes: {
      "/healthz": () => Response.json({ ok: true }),
      "/": () => Response.json({ ok: true, service: "ch-relay share endpoint" }),
      "/client/catalog": { GET: (req) => clientCatalog(req) },
      "/v1/models": { GET: (req) => listModels(req) },
      // Chat Completions surface for OpenAI-compatible harnesses (OpenCode,
      // Pi, …): same token gate, converted onto the Responses pipeline.
      "/v1/chat/completions": {
        POST: async (req) => {
          const gate = await authorize(req);
          if (!gate.ok) return gate.response;
          try {
            const { toResponsesBody, toChatCompletionJson, toChatCompletionStream } = await import("../chatcompletions.ts");
            const raw = (await req.json()) as Record<string, unknown>;
            if (!raw?.model) return jsonError(400, "missing model", "invalid_request_error");
            const inner = new Request("http://share.local/v1/responses", {
              method: "POST",
              headers: req.headers,
              body: JSON.stringify(toResponsesBody(raw)),
              signal: req.signal,
            });
            const res = await handleResponses(inner, false, gate.identity);
            if (!res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) return res;
            return raw.stream === true
              ? toChatCompletionStream(res, String(raw.model))
              : await toChatCompletionJson(res, String(raw.model));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("share chat completion failed", redact(msg));
            return jsonError(500, "internal error");
          }
        },
      },
      "/v1/responses": { POST: (req) => guarded(req, false) },
      "/v1/responses/compact": { POST: (req) => guarded(req, true) },
      "/v1/images/generations": { POST: (req) => guardedImages(req, "generations") },
      "/v1/images/edits": { POST: (req) => guardedImages(req, "edits") },
    },
    fetch(req) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return new Response("websocket not supported", { status: 426 });
      return jsonError(404, "not found", "not_found");
    },
    error(err) {
      log.error("share server error", String(err));
      return jsonError(500, "internal error");
    },
  });
  log.info(`ch-relay share endpoint on http://${hostname}:${server.port}`);
  return server;
}

