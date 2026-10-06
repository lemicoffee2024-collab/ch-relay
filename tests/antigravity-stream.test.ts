import { beforeEach, expect, test } from "bun:test";
import { useMemoryDb } from "../src/store/db.ts";
import { translateCcaStream } from "../src/providers/antigravity/stream.ts";
import { ToolNameCodec } from "../src/providers/antigravity/schema.ts";
import { lookupSignature } from "../src/providers/antigravity/signatures.ts";
import type { AdapterEvent } from "../src/lib/sse.ts";

beforeEach(() => {
  useMemoryDb();
});

const SIG = "c2lnbmF0dXJlLWJsb2ItMTIzNDU2Nzg5MA==";

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("");
  return new Response(text).body!;
}

async function collect(frames: unknown[], codec = new ToolNameCodec()): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of translateCcaStream(sse(frames), { wire: "gemini-3.8-flash-medium", sessionId: "-1", codec })) out.push(e);
  return out;
}

const wrap = (parts: unknown[], extra: Record<string, unknown> = {}, cand: Record<string, unknown> = {}) => ({
  response: { candidates: [{ content: { role: "model", parts }, ...cand }], ...extra },
});

test("text, thoughts, function call with signature, usage", async () => {
  const codec = new ToolNameCodec();
  const wireName = codec.toWire("weird.name");
  const events = await collect(
    [
      wrap([{ text: "pondering", thought: true, thoughtSignature: SIG }]),
      wrap([{ text: "Hello " }]),
      wrap([{ text: "world" }]),
      wrap(
        [{ functionCall: { name: wireName, args: { a: 1 } } }],
        { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40 } },
        { finishReason: "STOP" },
      ),
    ],
    codec,
  );
  expect(events[0]).toEqual({ type: "reasoning_delta", text: "pondering" });
  expect(events[1]).toEqual({ type: "text_delta", text: "Hello " });
  expect(events[2]).toEqual({ type: "text_delta", text: "world" });
  const call = events[3] as Extract<AdapterEvent, { type: "tool_call" }>;
  expect(call.type).toBe("tool_call");
  expect(call.name).toBe("weird.name");
  expect(call.arguments).toBe('{"a":1}');
  expect(call.callId).toMatch(/^call_[0-9a-f]{8}$/);
  expect(call.extra).toEqual({ extra_content: { google: { thought_signature: SIG } } });
  expect(events[4]).toEqual({ type: "usage", usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, reasoningOutputTokens: 5 } });
  expect(events[5]).toEqual({ type: "finish", reason: "stop" });
  // Signature stored for replay by call id.
  expect(
    lookupSignature({ callId: call.callId, wireModel: "gemini-3.8-flash-medium", sessionId: "-1", name: "weird.name", args: { a: 1 }, useSessionCache: true }),
  ).toBe(SIG);
});

test("MAX_TOKENS → length; SAFETY → content_filter; missing finish → error", async () => {
  const len = await collect([wrap([{ text: "x" }], { usageMetadata: { promptTokenCount: 1 } }, { finishReason: "MAX_TOKENS" })]);
  expect(len.at(-1)).toEqual({ type: "finish", reason: "length" });
  const filt = await collect([wrap([], {}, { finishReason: "SAFETY" })]);
  expect(filt.at(-1)).toEqual({ type: "finish", reason: "content_filter" });
  const trunc = await collect([wrap([{ text: "x" }])]);
  expect(trunc.at(-1)?.type).toBe("error");
  const malformed = await collect([wrap([], {}, { finishReason: "MALFORMED_FUNCTION_CALL" })]);
  expect(malformed.at(-1)?.type).toBe("error");
  const cut = await collect([wrap([{ functionCall: { name: "f", args: {} } }], {}, { finishReason: "MAX_TOKENS" })]);
  expect(cut.at(-1)?.type).toBe("error");
});

test("error frame is terminal", async () => {
  const ev = await collect([{ error: { message: "boom" } }]);
  expect(ev).toEqual([{ type: "error", message: "Antigravity: boom" }]);
});
