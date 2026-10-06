// Request/response shaping for the ChatGPT Codex backend plus a passive SSE side-scanner.

import type { ResponsesRequest, Usage } from "../../types.ts";
import { ORIGINATOR } from "./oauth.ts";
import { wireEffort } from "./catalog.ts";
import { log } from "../../lib/log.ts";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const RESPONSES_URL = `${CODEX_BASE_URL}/responses`;
export const COMPACT_URL = `${CODEX_BASE_URL}/responses/compact`;
/** Codex image tool: POST {base}/images/generations | /images/edits. */
export const imagesUrl = (kind: "generations" | "edits") => `${CODEX_BASE_URL}/images/${kind}`;

/** Headers copied from the Codex request when present. */
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
  "x-openai-internal-codex-responses-lite",
  "user-agent",
  "version",
  "x-codex-image-turn-id",
];

export const HOP_BY_HOP = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "te",
  "trailer",
  "upgrade",
];

export function buildUpstreamHeaders(
  incoming: Headers,
  accessToken: string,
  chatgptAccountId: string | undefined,
  accept = "text/event-stream",
  contentType = "application/json",
): Headers {
  const h = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = incoming.get(name);
    if (v) h.set(name, v);
  }
  h.set("authorization", `Bearer ${accessToken}`);
  if (chatgptAccountId) h.set("chatgpt-account-id", chatgptAccountId);
  else h.delete("chatgpt-account-id");
  if (!h.has("originator")) h.set("originator", ORIGINATOR);
  h.set("content-type", contentType);
  h.set("accept", accept);
  return h;
}

/** Response headers for Codex: upstream headers minus hop-by-hop ones. */
export function downstreamHeaders(upstream: Headers, defaultType = "text/event-stream"): Headers {
  const h = new Headers();
  upstream.forEach((v, k) => {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) h.set(k, v);
  });
  if (!h.has("content-type")) h.set("content-type", defaultType);
  return h;
}

const STRIP_FIELDS = [
  "previous_response_id",
  "max_output_tokens",
  "metadata",
  "temperature",
  "top_p",
  "stop",
  "user",
  "prompt_cache_retention",
  "prompt_cache_options",
  "truncation",
];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function systemText(item: Record<string, unknown>): string | null {
  const c = item.content;
  if (c === undefined) return "";
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  let text = "";
  for (const b of c) {
    if (!isObj(b) || (b.type !== "input_text" && b.type !== "text") || typeof b.text !== "string") return null;
    text += b.text;
  }
  return text;
}

const isSystemMessage = (it: unknown): it is Record<string, unknown> =>
  isObj(it) && (it.type === undefined || it.type === "message") && it.role === "system";

/**
 * Rewrite a Codex Responses body for the ChatGPT backend:
 * - set the upstream model id;
 * - drop fields the backend rejects; default store=false;
 * - fold all-text system messages into `instructions` (atomic: all or none);
 * - with store=false, drop `item_reference` items.
 */
/**
 * rewriteBody plus effort clamping for wire models with a shorter effort ladder.
 */
export function upstreamBody(src: ResponsesRequest, wireModel: string, headers?: Headers): ResponsesRequest {
  const body = rewriteBody(src, wireModel);
  const effort = wireEffort(wireModel, body.reasoning?.effort);
  if (body.reasoning && effort !== body.reasoning.effort) body.reasoning = { ...body.reasoning, effort };
  return body;
}

export function rewriteBody(src: ResponsesRequest, wireModel: string): ResponsesRequest {
  const body: ResponsesRequest = { ...src, model: wireModel };
  for (const f of STRIP_FIELDS) delete body[f];
  // The Codex backend only accepts unstored responses — force it, clients
  // like Codex Desktop still send store:true and get a hard 400 otherwise.
  body.store = false;
  // Responses-Lite rejects the request outright when parallel_tool_calls=true;
  // clamping to false keeps parallel-capable clients working, just sequentially.
  body.parallel_tool_calls = false;
  if (Array.isArray(body.input)) {
    let input = body.input;
    const texts: string[] = [];
    let foldable = true;
    let saw = false;
    for (const it of input) {
      if (!isSystemMessage(it)) continue;
      saw = true;
      const t = systemText(it);
      if (t === null) {
        foldable = false;
        break;
      }
      texts.push(t);
    }
    if (saw && foldable) {
      input = input.filter((it) => !isSystemMessage(it));
      const folded = texts.filter(Boolean).join("\n\n");
      if (folded) body.instructions = body.instructions ? `${body.instructions}\n\n${folded}` : folded;
    }
    if (body.store === false) input = input.filter((it) => !(isObj(it) && it.type === "item_reference"));
    // Repair poisoned history: a function_call whose arguments never reached
    // the client ("") fails upstream schema validation against additional_tools
    // and kills every later turn with response.failed — normalize to "{}".
    input = input.map((it) => {
      if (!isObj(it) || it.type !== "function_call") return it;
      const a = it.arguments;
      if (typeof a === "string" && a) {
        try { JSON.parse(a); return it; } catch { /* fall through */ }
      }
      return { ...it, arguments: "{}" };
    });
    body.input = input;
  }
  return body;
}

// ---------------------------------------------------------------------------
// SSE side-scanner
// ---------------------------------------------------------------------------

export const QUOTA_ERROR_CODES = new Set(["usage_limit_reached", "rate_limit_exceeded", "insufficient_quota"]);

/**
 * Did upstream serve the requested wire model? OpenAI reports dated snapshot ids
 * ("gpt-6-luna-2026" for a "gpt-6-luna" request) — same family is fine, a
 * different base id means the request was rerouted.
 */
export function isServedModel(wire: string, reported: string): boolean {
  return reported === wire || reported.startsWith(`${wire}-`);
}

export function usageFromResponses(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const usage: Usage = { inputTokens: Number.isFinite(input) ? input : 0, outputTokens: Number.isFinite(output) ? output : 0 };
  const cached = Number(u.input_tokens_details?.cached_tokens);
  if (Number.isFinite(cached)) usage.cachedInputTokens = cached;
  const reasoning = Number(u.output_tokens_details?.reasoning_tokens);
  if (Number.isFinite(reasoning)) usage.reasoningOutputTokens = reasoning;
  return usage;
}

/**
 * Watches the bytes streamed to Codex without altering them. Extracts usage from the
 * terminal response event, the served model, the first output delta time and any
 * in-stream failure code.
 */
export class SseScanner {
  usage: Usage | undefined;
  model: string | undefined;
  /** Error code of response.failed / error events. */
  failedCode: string | undefined;
  failedMessage: string | undefined;
  failedError: Record<string, unknown> | undefined;
  completed = false;
  firstDeltaAt: number | undefined;
  private buf = "";
  private data: string[] = [];
  private event: string | undefined;
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
  }

  end(): void {
    this.buf += this.decoder.decode();
    if (this.buf) this.line(this.buf);
    this.buf = "";
    this.line("");
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.frame(this.event, this.data.join("\n"));
      this.data = [];
      this.event = undefined;
    } else if (line.startsWith("data:")) {
      this.data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
    }
  }

  private frame(event: string | undefined, data: string): void {
    // Cheap pre-filter: only terminal / error frames are JSON-parsed.
    if (this.firstDeltaAt === undefined && (event?.endsWith(".delta") || /"type"\s*:\s*"[^"]*\.delta"/.test(data.slice(0, 120)))) {
      this.firstDeltaAt = Date.now();
    }
    const interesting =
      (event && /^(response\.(completed|incomplete|failed|done|created)|error)$/.test(event)) ||
      (!event && /"type"\s*:\s*"(response\.(completed|incomplete|failed|done|created)|error)"/.test(data.slice(0, 200)));
    if (!interesting) return;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    const type: string = j?.type ?? event ?? "";
    const resp = j?.response;
    if (typeof resp?.model === "string") this.model = resp.model;
    if (type === "response.completed" || type === "response.incomplete" || type === "response.done") {
      this.completed = true;
      const u = usageFromResponses(resp?.usage);
      if (u) this.usage = u;
    } else if (type === "response.failed") {
      const err = resp?.error ?? j?.error;
      this.setError(err);
      const u = usageFromResponses(resp?.usage);
      if (u) this.usage = u;
    } else if (type === "error") {
      this.setError(j?.error ?? j);
    }
  }

  private setError(err: any): void {
    if (!err || typeof err !== "object") {
      this.failedCode ??= "upstream_error";
      return;
    }
    this.failedError = err;
    this.failedCode = String(err.code ?? err.type ?? "upstream_error");
    if (typeof err.message === "string") this.failedMessage = err.message;
  }

  get quotaFailure(): boolean {
    return this.failedCode !== undefined && QUOTA_ERROR_CODES.has(this.failedCode);
  }
}
