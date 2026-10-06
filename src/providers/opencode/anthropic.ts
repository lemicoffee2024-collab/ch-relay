// Anthropic Messages wire: Responses request -> /messages request, Messages SSE -> AdapterEvents.

import type { ResponsesRequest, Usage } from "../../types.ts";
import type { AdapterEvent } from "../../lib/sse.ts";
import { parseSse } from "../../lib/sse.ts";
import { buildTurns, type Turn, type UserPart } from "./history.ts";
import { clampEffort, metaFor } from "./models.ts";
import { loadReasoning, storeReasoning, type ThinkingBlock } from "./reasoning-cache.ts";
import { ToolMap, outputCallFields } from "./tools.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const DEFAULT_MAX_TOKENS = 32_000;

function imageBlock(url: string): Obj {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

function userBlocks(parts: UserPart[], vision: boolean): Obj[] {
  const out: Obj[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if (vision) out.push(imageBlock(p.url));
    else out.push({ type: "text", text: "[image omitted: this model does not accept image input]" });
  }
  return out;
}

function parseArgs(args: string): Obj {
  try {
    const v = JSON.parse(args || "{}");
    return isObj(v) ? v : { value: v };
  } catch {
    return {};
  }
}

/** Render neutral turns as Anthropic system + alternating messages. */
export function turnsToAnthropic(
  turns: Turn[],
  instructions: string | undefined,
  model: string,
  tools: ToolMap,
): { system: string; messages: Obj[] } {
  const vision = metaFor(model).image;
  const sys: string[] = [];
  if (instructions?.trim()) sys.push(instructions);
  let i = 0;
  while (i < turns.length && turns[i]!.kind === "system") sys.push((turns[i++] as { text: string }).text);

  const messages: Array<{ role: "user" | "assistant"; content: Obj[] }> = [];
  const push = (role: "user" | "assistant", blocks: Obj[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      // Tool results must lead a user message: keep them ahead of any merged text.
      if (role === "user" && blocks.some((b) => b.type === "tool_result")) {
        const results = blocks.filter((b) => b.type === "tool_result");
        const rest = blocks.filter((b) => b.type !== "tool_result");
        const lastResults = last.content.filter((b) => b.type === "tool_result");
        const lastRest = last.content.filter((b) => b.type !== "tool_result");
        last.content = [...lastResults, ...results, ...lastRest, ...rest];
      } else last.content.push(...blocks);
    } else messages.push({ role, content: blocks });
  };

  for (; i < turns.length; i++) {
    const t = turns[i]!;
    switch (t.kind) {
      case "system":
        push("user", [{ type: "text", text: `<system>\n${t.text}\n</system>` }]);
        break;
      case "user":
        push("user", userBlocks(t.parts, vision));
        break;
      case "assistant": {
        const blocks: Obj[] = [];
        // Replay signed thinking blocks recorded for this turn's calls.
        let thinking: ThinkingBlock[] | undefined;
        for (const c of t.calls) {
          thinking = loadReasoning(c.callId)?.blocks;
          if (thinking?.length) break;
        }
        for (const b of thinking ?? []) {
          blocks.push({ type: "thinking", thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) });
        }
        if (t.text) blocks.push({ type: "text", text: t.text });
        for (const c of t.calls) {
          blocks.push({ type: "tool_use", id: c.callId, name: tools.wireName(c.name, c.namespace), input: parseArgs(c.arguments) });
        }
        push("assistant", blocks);
        break;
      }
      case "tool_result": {
        const content: Obj[] = [];
        if (t.text) content.push({ type: "text", text: t.text });
        if (vision) for (const url of t.images) content.push(imageBlock(url));
        push("user", [{ type: "tool_result", tool_use_id: t.callId, content: content.length ? content : [{ type: "text", text: "(empty)" }] }]);
        break;
      }
    }
  }
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  return { system: sys.join("\n\n"), messages };
}

function toolChoice(choice: unknown, tools: ToolMap): Obj | undefined {
  if (choice === "auto" || choice === undefined || choice === null) return undefined;
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (isObj(choice) && typeof choice.name === "string") {
    const ns = typeof choice.namespace === "string" ? choice.namespace : undefined;
    return { type: "tool", name: tools.wireName(choice.name, ns) };
  }
  return undefined;
}

const THINKING_BUDGET: Record<string, number> = { minimal: 1024, low: 4096, medium: 10_000, high: 20_000, xhigh: 28_000, max: 31_999 };

export function buildAnthropicRequest(body: ResponsesRequest, model: string, effort: string | undefined): { request: Obj; tools: ToolMap } {
  const tools = new ToolMap(body.tools);
  const { system, messages } = turnsToAnthropic(buildTurns(body), body.instructions, model, tools);
  const request: Obj = {
    model,
    max_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (system) request.system = system;
  if (!tools.isEmpty) {
    request.tools = tools.tools.map((t) => ({ name: t.wireName, description: t.description, input_schema: t.parameters }));
    const tc = toolChoice(body.tool_choice, tools);
    if (tc) request.tool_choice = tc;
  }
  // Extended thinking only for models that advertise effort levels (Claude on Zen);
  // MiniMax thinks natively and takes no knob.
  const levels = metaFor(model).reasoningLevels;
  if (effort && effort !== "none" && levels.length && /^claude-/.test(model)) {
    const budget = THINKING_BUDGET[clampEffort(effort, levels)] ?? 10_000;
    const maxTokens = Math.max(request.max_tokens as number, budget + 8_000);
    request.max_tokens = maxTokens;
    request.thinking = { type: "enabled", budget_tokens: budget };
  } else {
    if (typeof body.temperature === "number") request.temperature = body.temperature;
    if (typeof body.top_p === "number" && typeof body.temperature !== "number") request.top_p = body.top_p;
  }
  return { request, tools };
}

// ---------------------------------------------------------------------------
// Stream translation
// ---------------------------------------------------------------------------

interface Block {
  type: string;
  id?: string;
  name?: string;
  text: string;
  signature?: string;
}

export async function* anthropicStreamEvents(body: ReadableStream<Uint8Array>, tools: ToolMap): AsyncGenerator<AdapterEvent> {
  const blocks = new Map<number, Block>();
  let thinking: ThinkingBlock[] = [];
  let reasoningText = "";
  let stopReason: string | null = null;
  let sawStop = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sawUsage = false;
  const turnCallIds: string[] = [];

  for await (const frame of parseSse(body)) {
    let ev: Obj;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const type = (ev.type as string) ?? frame.event;
    switch (type) {
      case "message_start": {
        const u = isObj(ev.message) && isObj(ev.message.usage) ? ev.message.usage : undefined;
        if (u) {
          sawUsage = true;
          const n = (v: unknown) => (typeof v === "number" ? v : 0);
          const cacheRead = n(u.cache_read_input_tokens);
          usage.inputTokens = n(u.input_tokens) + cacheRead + n(u.cache_creation_input_tokens);
          usage.cachedInputTokens = cacheRead;
          usage.outputTokens = n(u.output_tokens);
        }
        break;
      }
      case "content_block_start": {
        const index = typeof ev.index === "number" ? ev.index : blocks.size;
        const cb = isObj(ev.content_block) ? ev.content_block : {};
        const b: Block = { type: String(cb.type ?? "text"), text: "" };
        if (b.type === "tool_use") {
          b.id = typeof cb.id === "string" ? cb.id : `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
          b.name = String(cb.name ?? "");
          if (isObj(cb.input) && Object.keys(cb.input).length) b.text = JSON.stringify(cb.input);
        } else if (b.type === "text" && typeof cb.text === "string" && cb.text) {
          b.text = cb.text;
          yield { type: "text_delta", text: cb.text };
        } else if (b.type === "thinking") {
          if (typeof cb.thinking === "string" && cb.thinking) {
            b.text = cb.thinking;
            reasoningText += cb.thinking;
            yield { type: "reasoning_delta", text: cb.thinking };
          }
          if (typeof cb.signature === "string") b.signature = cb.signature;
        }
        blocks.set(index, b);
        break;
      }
      case "content_block_delta": {
        const b = blocks.get(typeof ev.index === "number" ? ev.index : -1);
        const d = isObj(ev.delta) ? ev.delta : {};
        if (!b) break;
        if (d.type === "text_delta" && typeof d.text === "string") {
          b.text += d.text;
          if (d.text) yield { type: "text_delta", text: d.text };
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
          b.text += d.thinking;
          reasoningText += d.thinking;
          if (d.thinking) yield { type: "reasoning_delta", text: d.thinking };
        } else if (d.type === "signature_delta" && typeof d.signature === "string") {
          b.signature = d.signature;
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          b.text += d.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const index = typeof ev.index === "number" ? ev.index : -1;
        const b = blocks.get(index);
        if (!b) break;
        if (b.type === "thinking") thinking.push({ thinking: b.text, ...(b.signature ? { signature: b.signature } : {}) });
        if (b.type === "redacted_thinking") break;
        if (b.type === "tool_use") {
          let args = b.text.trim() ? b.text : "{}";
          try {
            JSON.parse(args);
          } catch {
            yield { type: "error", message: `model produced invalid JSON arguments for tool "${b.name}"`, code: "invalid_tool_arguments" };
            return;
          }
          turnCallIds.push(b.id!);
          storeReasoning([b.id!], { text: reasoningText, blocks: thinking });
          const target = tools.resolve(b.name ?? "");
          const out = outputCallFields(target, args);
          yield { type: "tool_call", callId: b.id!, name: target.name, arguments: out.arguments, extra: out.extra };
        }
        blocks.delete(index);
        break;
      }
      case "message_delta": {
        const d = isObj(ev.delta) ? ev.delta : {};
        if (typeof d.stop_reason === "string") stopReason = d.stop_reason;
        const u = isObj(ev.usage) ? ev.usage : undefined;
        if (u) {
          sawUsage = true;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number" && u.input_tokens > 0) {
            const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : usage.cachedInputTokens ?? 0;
            const cacheWrite = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
            usage.inputTokens = u.input_tokens + cacheRead + cacheWrite;
            usage.cachedInputTokens = cacheRead;
          }
        }
        break;
      }
      case "message_stop":
        sawStop = true;
        break;
      case "error": {
        const e = isObj(ev.error) ? ev.error : {};
        yield { type: "error", message: String(e.message ?? "upstream error"), code: String(e.type ?? "upstream_error") };
        return;
      }
      default:
        break;
    }
    if (sawStop) break;
  }

  if (!sawStop && !stopReason) {
    yield { type: "error", message: "upstream stream ended before completion", code: "stream_truncated" };
    return;
  }
  if (sawUsage) yield { type: "usage", usage };
  const reason = stopReason === "max_tokens" ? "length" : stopReason === "refusal" ? "content_filter" : "stop";
  yield { type: "finish", reason };
}
