// OpenCode Zen / Go providers: API-key accounts, model discovery, and three upstream wires
// (Chat Completions translation, stateless Responses passthrough, Anthropic Messages translation).

import type { Account, CatalogModel, Provider, ProviderContext } from "../../types.ts";
import { ResponsesStreamBuilder, jsonError, sseResponse, type AdapterEvent } from "../../lib/sse.ts";
import { log, redact } from "../../lib/log.ts";
import { coolDown, pickAccount, retryAfterMs } from "../../pool.ts";
import { getCooldowns, isCooling, listAccounts, setStatus, upsertAccount } from "../../store/accounts.ts";
import { kvGet, kvSet } from "../../store/db.ts";
import { anthropicStreamEvents, buildAnthropicRequest } from "./anthropic.ts";
import { buildChatRequest, chatStreamEvents } from "./chat.ts";
import {
  BASE_URL,
  STATIC_MODELS,
  isChatModel,
  isFreeTierOnly,
  metaFor,
  wireFor,
  type OpencodeProviderId,
  type Wire,
} from "./models.ts";
import { buildResponsesRequest, passthroughStream, type PassthroughResult } from "./responses.ts";
import type { ToolMap } from "./tools.ts";

const USER_AGENT = "ch-relay/0.1.0";
const MODELS_TTL_MS = 60 * 60 * 1000;
const MAX_ROTATIONS = 4;
/** Zen often answers 429 without Retry-After; treat it as 15s. */
const ZEN_DEFAULT_RETRY_MS = 15_000;
const GO_DEFAULT_RETRY_MS = 10_000;
const SAME_KEY_429_RETRIES: Record<OpencodeProviderId, number> = { "opencode-zen": 2, "opencode-go": 6 };
const SAME_KEY_MAX_WAIT_MS = 60_000;
const SAME_KEY_STEP_MS = 10_000;
const FUNDS_COOLDOWN_MS = 30 * 60 * 1000;

let sleepImpl = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Test hook: replace the backoff sleep. */
export function _setSleepForTests(fn: typeof sleepImpl): void {
  sleepImpl = fn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

/** Stable Go session id for a conversation (`ch_<sha256[:32]>`). */
export function goSessionHeader(ctx: Pick<ProviderContext, "sessionKey" | "body">): string {
  let seed = ctx.sessionKey;
  if (!seed) {
    const input = ctx.body.input;
    if (typeof input === "string") seed = input;
    else if (Array.isArray(input)) {
      const firstUser = input.find((i) => i?.type === "message" && i.role === "user") ?? input.find((i) => i?.role === "user");
      if (firstUser) seed = JSON.stringify(firstUser.content ?? "");
    }
  }
  return `ch_${sha256hex(`ch-relay/opencode-go\0${seed ?? crypto.randomUUID()}`).slice(0, 32)}`;
}

function upstreamMessage(text: string, status: number): { message: string; type?: string } {
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    if (typeof e?.message === "string") return { message: e.message, type: typeof e.type === "string" ? e.type : undefined };
    if (typeof e === "string") return { message: e };
  } catch {
    // not JSON
  }
  return { message: text.trim().slice(0, 300) || `HTTP ${status}` };
}

function errorResponse(status: number, message: string, retryAfterMsValue?: number): Response {
  const res = jsonError(status, message, status === 429 ? "rate_limit_exceeded" : "upstream_error");
  if (retryAfterMsValue !== undefined) res.headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMsValue / 1000))));
  return res;
}

function apiKeyOf(a: Account): string {
  return String(a.credential.apiKey ?? "");
}

function headersFor(pid: OpencodeProviderId, wire: Wire, apiKey: string, ctx: ProviderContext): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": USER_AGENT,
  };
  if (wire === "anthropic") {
    h["x-api-key"] = apiKey;
    h["anthropic-version"] = "2023-06-01";
  } else h.authorization = `Bearer ${apiKey}`;
  if (pid === "opencode-go") h["x-opencode-session"] = goSessionHeader(ctx);
  return h;
}

const PATH: Record<Wire, string> = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" };

interface Prepared {
  body: Record<string, unknown>;
  tools?: ToolMap;
  mapping?: ReturnType<typeof buildResponsesRequest>["mapping"];
}

interface PrepFlags {
  dropReasoning: boolean;
  noThinking: boolean;
}

function prepare(wire: Wire, ctx: ProviderContext, flags: PrepFlags): Prepared {
  if (wire === "responses") {
    const { request, mapping } = buildResponsesRequest(ctx.body, ctx.model, ctx.effort, { dropReasoning: flags.dropReasoning });
    return { body: request, mapping };
  }
  if (wire === "anthropic") {
    const { request, tools } = buildAnthropicRequest(ctx.body, ctx.model, flags.noThinking ? undefined : ctx.effort);
    return { body: request, tools };
  }
  const { request, tools } = buildChatRequest(ctx.body, ctx.model, ctx.effort);
  return { body: request, tools };
}

// ---------------------------------------------------------------------------
// Streaming responses
// ---------------------------------------------------------------------------

function translatedStream(
  ctx: ProviderContext,
  account: Account,
  events: AsyncGenerator<AdapterEvent>,
): Response {
  const builder = new ResponsesStreamBuilder(ctx.requestedModel);
  let firstTokenAt: number | undefined;
  async function* gen(): AsyncGenerator<string> {
    let error: string | undefined;
    try {
      for await (const ev of events) {
        if (!firstTokenAt && (ev.type === "text_delta" || ev.type === "reasoning_delta" || ev.type === "tool_call")) {
          firstTokenAt = Date.now();
        }
        if (ev.type === "error") error = ev.message;
        const chunk = builder.push(ev);
        if (chunk) yield chunk;
        if (builder.isFinished) break;
      }
      if (!builder.isFinished) {
        error = "upstream stream ended before completion";
        yield builder.push({ type: "error", message: error, code: "stream_truncated" });
      }
    } catch (err) {
      if (ctx.signal.aborted && builder.isFinished) {
        error = undefined;
      } else {
        error = ctx.signal.aborted ? "client cancelled" : `stream error: ${err instanceof Error ? err.message : String(err)}`;
        if (!ctx.signal.aborted) yield builder.push({ type: "error", message: error, code: "stream_error" });
      }
    } finally {
      ctx.finish({
        accountId: account.id,
        servedModel: ctx.model,
        status: error ? (ctx.signal.aborted ? 499 : 502) : 200,
        usage: builder.finalUsage,
        error: error ? redact(error) : undefined,
        firstTokenMs: firstTokenAt ? firstTokenAt - ctx.startedAt : undefined,
      });
    }
  }
  return sseResponse(gen());
}

function passthroughResponse(ctx: ProviderContext, account: Account, upstream: ReadableStream<Uint8Array>, prepared: Prepared): Response {
  const result: PassthroughResult = { status: "truncated" };
  async function* gen(): AsyncGenerator<string> {
    let error: string | undefined;
    try {
      yield* passthroughStream(upstream, prepared.mapping ?? { names: new Map() }, result, ctx.requestedModel);
      if (result.status === "failed" || result.status === "truncated") error = result.error;
    } catch (err) {
      if (ctx.signal.aborted && result.status === "completed") {
        error = undefined;
      } else {
        error = ctx.signal.aborted ? "client cancelled" : `stream error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      ctx.finish({
        accountId: account.id,
        servedModel: ctx.model,
        status: error ? (ctx.signal.aborted ? 499 : 502) : 200,
        usage: result.usage,
        error: error ? redact(error) : undefined,
        firstTokenMs: result.firstTokenAt ? result.firstTokenAt - ctx.startedAt : undefined,
      });
    }
  }
  return sseResponse(gen());
}

// ---------------------------------------------------------------------------
// Request handling with retry / key rotation
// ---------------------------------------------------------------------------

function hasOtherUsable(pid: OpencodeProviderId, tried: Set<string>): boolean {
  return listAccounts(pid).some((a) => a.enabled && a.status !== "needs_reauth" && !tried.has(a.id) && !isCooling(a.id, "*"));
}

async function handle(pid: OpencodeProviderId, ctx: ProviderContext): Promise<Response> {
  const wire = wireFor(pid, ctx.model);
  const url = BASE_URL[pid] + PATH[wire];
  const tried = new Set<string>();
  const flags: PrepFlags = { dropReasoning: false, noThinking: false };
  let lastErr: { status: number; message: string; retryAfter?: number; accountId: string | null } | null = null;

  const fail = (status: number, message: string, accountId: string | null, retryAfter?: number) => {
    ctx.finish({ accountId, servedModel: ctx.model, status, error: redact(message) });
    return errorResponse(status, message, retryAfter);
  };

  for (let rotation = 0; rotation < MAX_ROTATIONS; rotation++) {
    const account = pickAccount(pid, { sessionKey: ctx.sessionKey, exclude: tried });
    if (!account) break;
    tried.add(account.id);
    const apiKey = apiKeyOf(account);
    let sameKey429 = 0;
    let waited = 0;
    let transientRetries = 0;
    let fixups = 0;

    while (true) {
      if (ctx.signal.aborted) return fail(499, "client cancelled", account.id);
      const prepared = prepare(wire, ctx, flags);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headersFor(pid, wire, apiKey, ctx),
          body: JSON.stringify(prepared.body),
          signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal.aborted) return fail(499, "client cancelled", account.id);
        const message = `network error: ${err instanceof Error ? err.message : String(err)}`;
        if (transientRetries++ < 1) {
          await sleepImpl(500, ctx.signal);
          continue;
        }
        lastErr = { status: 502, message, accountId: account.id };
        break;
      }

      if (res.ok && res.body) {
        if (wire === "responses") return passthroughResponse(ctx, account, res.body, prepared);
        const events =
          wire === "anthropic"
            ? anthropicStreamEvents(res.body, prepared.tools!)
            : chatStreamEvents(res.body, prepared.tools!, { eofTolerance: true });
        return translatedStream(ctx, account, events);
      }

      const text = await res.text().catch(() => "");
      const { message, type } = upstreamMessage(text, res.status);
      const status = res.status;
      log.warn(`${pid} ${ctx.model} upstream ${status} acct=${account.id}: ${redact(message)}`);

      if (status === 429) {
        const ra = retryAfterMs(res.headers) ?? (pid === "opencode-zen" ? ZEN_DEFAULT_RETRY_MS : GO_DEFAULT_RETRY_MS);
        const step = Math.min(ra, SAME_KEY_STEP_MS);
        if (!hasOtherUsable(pid, tried) && sameKey429 < SAME_KEY_429_RETRIES[pid] && waited + step <= SAME_KEY_MAX_WAIT_MS) {
          sameKey429++;
          waited += step;
          await sleepImpl(step, ctx.signal);
          continue;
        }
        coolDown(account.id, "*", ra, `rate limited: ${redact(message)}`);
        lastErr = { status: 429, message, retryAfter: ra, accountId: account.id };
        break;
      }
      if (status === 401) {
        setStatus(account.id, "error", "invalid API key");
        coolDown(account.id, "*", FUNDS_COOLDOWN_MS, "invalid API key");
        lastErr = { status, message, accountId: account.id };
        break;
      }
      // Billing / subscription problems are specific to this key: park it and try another.
      if (status === 402 || (status === 403 && /subscription|insufficient|funds|billing|quota/i.test(message))) {
        coolDown(account.id, "*", FUNDS_COOLDOWN_MS, `billing: ${redact(message)}`);
        lastErr = { status, message, accountId: account.id };
        break;
      }
      if (status === 400 && fixups < 2) {
        if (/Invalid upload request\./.test(message)) {
          fixups++;
          continue;
        }
        if (wire === "responses" && !flags.dropReasoning && /encrypted_content|reasoning/i.test(message)) {
          flags.dropReasoning = true;
          fixups++;
          continue;
        }
        if (wire === "anthropic" && !flags.noThinking && /thinking/i.test(message)) {
          flags.noThinking = true;
          fixups++;
          continue;
        }
      }
      if ([500, 502, 503, 504].includes(status)) {
        if (transientRetries++ < 1) {
          await sleepImpl(1000, ctx.signal);
          continue;
        }
        lastErr = { status, message, accountId: account.id };
        break;
      }
      // Non-retryable (bad request, free-tier refusal, unknown model, ...): surface as-is.
      const hint = type === "FreeTierError" || /free tier can only be used/i.test(message)
        ? " (OpenCode free-tier models are restricted to the OpenCode client; use a paid model)"
        : "";
      return fail(status, `${pid}: ${message}${hint}`, account.id);
    }
  }

  if (lastErr) return fail(lastErr.status, `${pid}: ${lastErr.message}`, lastErr.accountId, lastErr.retryAfter);
  const reasons = [
    ...new Set(listAccounts(pid).flatMap((a) => getCooldowns(a.id).map((c) => c.reason ?? "cooling down"))),
  ].slice(0, 3);
  return fail(
    503,
    `${pid}: no usable API key` + (reasons.length ? ` (all keys cooling down: ${reasons.join("; ")})` : " (add one in ch-relay)"),
    null,
  );
}

// ---------------------------------------------------------------------------
// Models / keys
// ---------------------------------------------------------------------------

async function discoverIds(pid: OpencodeProviderId): Promise<string[]> {
  const cached = kvGet("opencode-models", pid);
  if (cached) {
    try {
      const ids = JSON.parse(cached);
      if (Array.isArray(ids) && ids.length) return ids as string[];
    } catch {
      // refetch
    }
  }
  const account = listAccounts(pid).find((a) => a.enabled);
  try {
    const res = await fetch(`${BASE_URL[pid]}/models`, {
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(account ? { authorization: `Bearer ${apiKeyOf(account)}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && !!id);
    if (!ids.length) throw new Error("empty model list");
    kvSet("opencode-models", pid, JSON.stringify(ids), MODELS_TTL_MS);
    return ids;
  } catch (err) {
    log.warn(`${pid} model discovery failed, using static list: ${redact(String(err))}`);
    return STATIC_MODELS[pid];
  }
}

export function catalogModel(pid: OpencodeProviderId, id: string): CatalogModel {
  const meta = metaFor(id);
  const slug = `${pid}/${id}`;
  return {
    slug,
    displayName: slug,
    provider: pid,
    contextWindow: meta.contextWindow,
    reasoningLevels: meta.reasoningLevels,
    defaultReasoning: meta.defaultReasoning,
    inputModalities: meta.image ? ["text", "image"] : ["text"],
    ...(isFreeTierOnly(pid, id) ? { hidden: true } : {}),
  };
}

async function validateKey(pid: OpencodeProviderId, apiKey: string): Promise<void> {
  const base = BASE_URL[pid];
  const models = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (models.status === 401 || models.status === 403) throw new Error(`${pid}: API key rejected (HTTP ${models.status})`);
  if (!models.ok) throw new Error(`${pid}: cannot reach ${base}/models (HTTP ${models.status})`);
  // /models does not authenticate; probe an authenticated route with a non-existent model
  // (a valid key gets a 4xx about the model, an invalid key gets 401 AuthError; nothing is billed).
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };
  if (pid === "opencode-go") headers["x-opencode-session"] = `ch_${sha256hex(`ch-relay/key-check\0${crypto.randomUUID()}`).slice(0, 32)}`;
  const probe = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "ch-relay-key-check", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await probe.text().catch(() => "");
  if (probe.status === 401 || probe.status === 403 || /AuthError|Invalid API key/i.test(text)) {
    throw new Error(`${pid}: API key rejected (${redact(upstreamMessage(text, probe.status).message)})`);
  }
}

function makeProvider(pid: OpencodeProviderId): Provider {
  return {
    id: pid,
    handle: (ctx) => handle(pid, ctx),
    async models() {
      const ids = await discoverIds(pid);
      return [...new Set(ids)].filter(isChatModel).map((id) => catalogModel(pid, id));
    },
    async addApiKey(apiKey: string, label?: string) {
      const key = apiKey.trim();
      if (!key) throw new Error("API key is empty");
      if (listAccounts(pid).some((a) => apiKeyOf(a) === key)) throw new Error(`${pid}: this API key is already added`);
      await validateKey(pid, key);
      return upsertAccount({
        provider: pid,
        label: label?.trim() || `${pid} …${key.slice(-4)}`,
        credential: { apiKey: key },
        meta: { addedVia: "api-key" },
      });
    },
  };
}

export const opencodeZenProvider: Provider = makeProvider("opencode-zen");
export const opencodeGoProvider: Provider = makeProvider("opencode-go");
