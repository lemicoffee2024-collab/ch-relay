// Chat Completions wire: Responses request -> chat request, chat SSE -> AdapterEvents.

import type { ResponsesRequest, Usage } from "../../types.ts";
import type { AdapterEvent } from "../../lib/sse.ts";
import { parseSse } from "../../lib/sse.ts";
import { buildTurns, type Turn, type UserPart } from "./history.ts";
import {
  AUTO_TOOL_CHOICE_ONLY_MODELS,
  LOCKED_SAMPLING_MODELS,
  chatReasoningFields,
  metaFor,
  noJsonSchema,
  preservesReasoning,
} from "./models.ts";
import { reasoningForCalls, storeReasoning } from "./reasoning-cache.ts";
import { ToolMap, outputCallFields } from "./tools.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const IMAGE_OMITTED = "[image omitted: this model does not accept image input]";

function userContent(parts: UserPart[], vision: boolean): string | Obj[] {
  if (parts.every((p) => p.type === "text")) return parts.map((p) => (p as { text: string }).text).join("");
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : vision
        ? { type: "image_url", image_url: { url: p.url, ...(p.detail && p.detail !== "original" ? { detail: p.detail } : {}) } }
        : { type: "text", text: IMAGE_OMITTED },
  );
}

/** Render neutral turns as Chat Completions messages. */
export function turnsToChatMessages(turns: Turn[], instructions: string | undefined, model: string, tools: ToolMap): Obj[] {
  const vision = metaFor(model).image;
  const preserve = preservesReasoning(model);
  const messages: Obj[] = [];

  // Leading instructions + system/developer turns become one system message.
  const sys: string[] = [];
  if (instructions?.trim()) sys.push(instructions);
  let i = 0;
  while (i < turns.length && turns[i]!.kind === "system") sys.push((turns[i++] as { text: string }).text);
  if (sys.length) messages.push({ role: "system", content: sys.join("\n\n") });

  let pendingImages: Obj[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    messages.push({ role: "user", content: [{ type: "text", text: "Image output from the preceding tool call(s):" }, ...pendingImages] });
    pendingImages = [];
  };

  for (; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.kind !== "tool_result") flushImages();
    switch (t.kind) {
      case "system":
        messages.push({ role: "system", content: t.text });
        break;
      case "user":
        messages.push({ role: "user", content: userContent(t.parts, vision) });
        break;
      case "assistant": {
        const msg: Obj = { role: "assistant", content: t.text };
        if (t.calls.length) {
          msg.tool_calls = t.calls.map((c) => ({
            id: c.callId,
            type: "function",
            function: { name: tools.wireName(c.name, c.namespace), arguments: c.arguments },
          }));
        }
        if (preserve) {
          let reasoning = t.reasoning;
          if (!reasoning && t.calls.length) reasoning = reasoningForCalls(t.calls.map((c) => c.callId));
          // DeepSeek-style thinking mode rejects a tool-call turn without reasoning_content.
          if (!reasoning && t.calls.length) reasoning = " ";
          if (reasoning) msg.reasoning_content = reasoning;
        }
        messages.push(msg);
        break;
      }
      case "tool_result": {
        let text = t.text;
        if (t.images.length && !vision) text += (text ? "\n" : "") + IMAGE_OMITTED;
        messages.push({ role: "tool", tool_call_id: t.callId, content: text });
        if (vision) for (const url of t.images) pendingImages.push({ type: "image_url", image_url: { url } });
        break;
      }
    }
  }
  flushImages();
  return messages;
}

function toolChoice(choice: unknown, model: string, tools: ToolMap): unknown {
  if (choice === undefined || choice === null) return undefined;
  let out: unknown;
  if (choice === "auto" || choice === "none" || choice === "required") out = choice;
  else if (isObj(choice) && typeof choice.name === "string") {
    const ns = typeof choice.namespace === "string" ? choice.namespace : undefined;
    out = { type: "function", function: { name: tools.wireName(choice.name, ns) } };
  } else return undefined;
  if (AUTO_TOOL_CHOICE_ONLY_MODELS.includes(model)) return out === "none" ? "none" : "auto";
  return out;
}

function responseFormat(body: ResponsesRequest, model: string): Obj | undefined {
  const fmt = isObj(body.text) && isObj(body.text.format) ? body.text.format : undefined;
  if (!fmt) return undefined;
  if (fmt.type === "json_object") return { type: "json_object" };
  if (fmt.type !== "json_schema") return undefined;
  if (noJsonSchema(model)) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: typeof fmt.name === "string" ? fmt.name : "response",
      ...(fmt.schema !== undefined ? { schema: fmt.schema } : {}),
      ...(typeof fmt.strict === "boolean" ? { strict: fmt.strict } : {}),
    },
  };
}

export function buildChatRequest(body: ResponsesRequest, model: string, effort: string | undefined): { request: Obj; tools: ToolMap } {
  const tools = new ToolMap(body.tools);
  const messages = turnsToChatMessages(buildTurns(body), body.instructions, model, tools);
  const request: Obj = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (!tools.isEmpty) {
    request.tools = tools.tools.map((t) => ({
      type: "function",
      function: { name: t.wireName, description: t.description, parameters: t.parameters },
    }));
    const tc = toolChoice(body.tool_choice, model, tools);
    if (tc !== undefined) request.tool_choice = tc;
    if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
  }
  const maxTokens = typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined;
  if (maxTokens !== undefined) request.max_tokens = maxTokens;
  if (!LOCKED_SAMPLING_MODELS.includes(model)) {
    if (typeof body.temperature === "number") request.temperature = body.temperature;
    if (typeof body.top_p === "number") request.top_p = body.top_p;
  }
  Object.assign(request, chatReasoningFields(model, effort, maxTokens));
  const rf = responseFormat(body, model);
  if (rf) request.response_format = rf;
  return { request, tools };
}

// ---------------------------------------------------------------------------
// Stream translation
// ---------------------------------------------------------------------------

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export function chatUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pd = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const cd = isObj(u.completion_tokens_details) ? u.completion_tokens_details : {};
  const cached = num(pd.cached_tokens) || num(u.prompt_cache_hit_tokens) || num(u.cached_tokens);
  return {
    inputTokens: num(u.prompt_tokens) || num(u.input_tokens),
    outputTokens: num(u.completion_tokens) || num(u.output_tokens),
    cachedInputTokens: cached,
    reasoningOutputTokens: num(cd.reasoning_tokens),
  };
}

function isCompleteJson(s: string): boolean {
  if (!s.trim()) return true;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (isObj(e) && typeof e.message === "string") return e.message;
  return JSON.stringify(e);
}

/**
 * Translate a Chat Completions SSE body into AdapterEvents.
 * Tool calls are buffered per index and flushed on finish_reason / [DONE] / tolerated EOF.
 */
export async function* chatStreamEvents(
  body: ReadableStream<Uint8Array>,
  tools: ToolMap,
  opts: { eofTolerance?: boolean } = {},
): AsyncGenerator<AdapterEvent> {
  const calls = new Map<number, PendingCall>();
  let reasoningSinceFlush = "";
  let finishReason: string | null = null;
  let flushed = false;
  let sawDone = false;
  let usage: Usage | undefined;

  function* flushCalls(): Generator<AdapterEvent> {
    if (flushed) return;
    flushed = true;
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const valid = ordered.filter((c) => c.name);
    if (!valid.length) return;
    storeReasoning(
      valid.map((c) => c.id),
      { text: reasoningSinceFlush },
    );
    for (const c of valid) {
      const args = c.args.trim() ? c.args : "{}";
      const target = tools.resolve(c.name);
      const out = outputCallFields(target, args);
      yield { type: "tool_call", callId: c.id, name: target.name, arguments: out.arguments, extra: out.extra };
    }
  }

  for await (const frame of parseSse(body)) {
    const data = frame.data.trim();
    if (!data) continue;
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: Obj;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      yield { type: "error", message: errorMessage(chunk.error), code: "upstream_error" };
      return;
    }
    const u = chatUsage(chunk.usage);
    if (u) usage = u;
    const choice = Array.isArray(chunk.choices) && isObj(chunk.choices[0]) ? (chunk.choices[0] as Obj) : undefined;
    if (!choice) continue;
    const delta = isObj(choice.delta) ? choice.delta : isObj(choice.message) ? choice.message : {};
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoning) {
      reasoningSinceFlush += reasoning;
      yield { type: "reasoning_delta", text: reasoning };
    }
    if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isObj(tc)) continue;
        const index = typeof tc.index === "number" ? tc.index : calls.size;
        let c = calls.get(index);
        if (!c) {
          c = { id: "", name: "", args: "" };
          calls.set(index, c);
        }
        if (typeof tc.id === "string" && tc.id && !c.id) c.id = tc.id;
        const fn = isObj(tc.function) ? tc.function : {};
        if (typeof fn.name === "string" && fn.name) c.name = c.name && c.name !== fn.name ? c.name + fn.name : fn.name;
        if (typeof fn.arguments === "string") c.args += fn.arguments;
        else if (isObj(fn.arguments)) c.args = JSON.stringify(fn.arguments);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
  }

  for (const c of calls.values()) if (!c.id) c.id = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  if (!finishReason && !sawDone) {
    // Stream closed without a protocol terminal. Zen Go does this after a fully assembled
    // tool call; anything else is a truncated response.
    const pending = [...calls.values()];
    const tolerable = opts.eofTolerance !== false && pending.length > 0 && pending.every((c) => c.name && isCompleteJson(c.args));
    if (!tolerable) {
      yield { type: "error", message: "upstream stream ended before completion", code: "stream_truncated" };
      return;
    }
  }

  if (finishReason === "length") {
    // Drop half-written tool calls; completed ones are still delivered.
    for (const [k, c] of calls) if (!isCompleteJson(c.args)) calls.delete(k);
  } else {
    for (const c of calls.values()) {
      if (c.name && !isCompleteJson(c.args)) {
        yield { type: "error", message: `model produced invalid JSON arguments for tool "${c.name}"`, code: "invalid_tool_arguments" };
        return;
      }
    }
  }
  yield* flushCalls();
  if (usage) yield { type: "usage", usage };
  const reason = finishReason === "length" ? "length" : finishReason === "content_filter" ? "content_filter" : "stop";
  yield { type: "finish", reason };
}
