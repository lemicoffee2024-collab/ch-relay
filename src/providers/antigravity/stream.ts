// Translate the Cloud Code Assist SSE stream into normalised AdapterEvents.
import { parseSse, type AdapterEvent } from "../../lib/sse.ts";
import type { Usage } from "../../types.ts";
import type { ToolNameCodec } from "./schema.ts";
import { isSignatureError, isValidSignature, partSignature, rememberSignature } from "./signatures.ts";

const CONTENT_FILTER = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

export interface StreamOptions {
  wire: string;
  sessionId: string;
  codec: ToolNameCodec;
  /** Called when the upstream rejects a replayed thought signature. */
  onSignatureError?: (message: string) => void;
}

export function usageFromGemini(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const thoughts = n(u.thoughtsTokenCount);
  // Responses semantics: output_tokens includes reasoning tokens (Gemini reports them apart).
  return {
    inputTokens: n(u.promptTokenCount),
    outputTokens: n(u.candidatesTokenCount) + thoughts,
    cachedInputTokens: n(u.cachedContentTokenCount),
    reasoningOutputTokens: thoughts,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function* translateCcaStream(body: ReadableStream<Uint8Array>, opts: StreamOptions): AsyncGenerator<AdapterEvent> {
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  let sawUsage = false;
  let toolCalls = 0;
  let pendingThoughtSig: string | undefined;

  for await (const frame of parseSse(body)) {
    const payload = frame.data.trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      yield { type: "error", message: "malformed upstream SSE data frame" };
      return;
    }
    if (!isRecord(chunk)) continue;
    if (chunk.error) {
      const message = String((chunk.error as { message?: unknown }).message ?? "upstream error");
      if (isSignatureError(message) || /invalid_argument/i.test(message)) opts.onSignatureError?.(message);
      yield { type: "error", message: `Antigravity: ${message}` };
      return;
    }
    const root = isRecord(chunk.response) ? chunk.response : chunk;
    if (isRecord(root.usageMetadata)) {
      usage = usageFromGemini(root.usageMetadata);
      sawUsage = true;
    }
    const cand = Array.isArray(root.candidates) ? root.candidates[0] : undefined;
    if (!isRecord(cand)) continue;
    if (typeof cand.finishReason === "string" && cand.finishReason) finishReason = cand.finishReason;
    const parts = isRecord(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    for (const raw of parts) {
      if (!isRecord(raw)) continue;
      const sig = partSignature(raw);
      if (raw.thought === true && isValidSignature(sig)) pendingThoughtSig = sig;
      if (typeof raw.text === "string" && raw.text) {
        yield raw.thought === true ? { type: "reasoning_delta", text: raw.text } : { type: "text_delta", text: raw.text };
      }
      const fc = raw.functionCall;
      if (isRecord(fc) && typeof fc.name === "string" && fc.name.trim()) {
        toolCalls++;
        const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
        const name = opts.codec.fromWire(fc.name);
        const args = isRecord(fc.args) ? fc.args : {};
        const callSig = isValidSignature(sig) ? sig : pendingThoughtSig;
        if (callSig) rememberSignature({ callId, wireModel: opts.wire, sessionId: opts.sessionId, name, args, sig: callSig });
        yield {
          type: "tool_call",
          callId,
          name,
          arguments: JSON.stringify(args),
          ...(callSig ? { extra: { extra_content: { google: { thought_signature: callSig } } } } : {}),
        };
      }
    }
  }

  if (usage) yield { type: "usage", usage };
  if (finishReason === "MALFORMED_FUNCTION_CALL") {
    yield { type: "error", message: "Antigravity: model produced a malformed function call", code: "malformed_function_call" };
    return;
  }
  if (finishReason === "MAX_TOKENS" && toolCalls > 0) {
    yield { type: "error", message: "Antigravity: response truncated (MAX_TOKENS) during a tool call", code: "truncated" };
    return;
  }
  if (!finishReason && !sawUsage) {
    yield { type: "error", message: "Antigravity: stream ended without a finish signal (possible truncation)", code: "truncated" };
    return;
  }
  if (finishReason === "MAX_TOKENS") yield { type: "finish", reason: "length" };
  else if (finishReason && CONTENT_FILTER.has(finishReason)) yield { type: "finish", reason: "content_filter" };
  else yield { type: "finish", reason: "stop" };
}
