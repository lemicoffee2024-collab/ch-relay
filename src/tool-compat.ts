/**
 * Tool compatibility for routed (non-ChatGPT) providers.
 *
 * Codex sends tool shapes only OpenAI understands:
 *  - `custom` (freeform) tools, e.g. code-mode `exec` and `apply_patch`, called via `custom_tool_call`;
 *  - `namespace` groups (MCP servers, collaboration) whose inner tools carry a `namespace` on calls;
 *  - hosted tools (`web_search`, ...), which routed models cannot run.
 * Request side: flatten everything into plain function tools (`<ns>__<name>`, custom -> {input:string}).
 * Response side: rewrite the SSE stream so calls come back in the exact shape Codex declared.
 */
import { parseSse } from "./lib/sse.ts";
import type { ResponsesInputItem, ResponsesRequest } from "./types.ts";

interface ToolInfo {
  name: string;
  namespace?: string;
  custom: boolean;
}

export interface ToolMap {
  /** wire function name -> original identity */
  byWire: Map<string, ToolInfo>;
}

const FUNCTION_LIKE = new Set(["function", "custom"]);

function wireName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

function customToFunction(t: Record<string, any>, name: string): Record<string, unknown> {
  const format = t.format && typeof t.format === "object" ? t.format : undefined;
  const grammarHint =
    format?.type === "grammar" && typeof format.definition === "string"
      ? `\nThe input must follow this ${format.syntax ?? ""} grammar:\n${String(format.definition).slice(0, 4000)}`
      : "";
  return {
    type: "function",
    name,
    description: `${t.description ?? ""}${grammarHint}`.trim(),
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: "Raw freeform input for this tool." } },
      required: ["input"],
      additionalProperties: false,
    },
  };
}

function flattenTool(t: Record<string, any>, namespace: string | undefined, out: Array<Record<string, unknown>>, map: ToolMap) {
  if (t.type === "namespace" && Array.isArray(t.tools)) {
    for (const inner of t.tools) flattenTool(inner, t.name, out, map);
    return;
  }
  if (!FUNCTION_LIKE.has(t.type) || typeof t.name !== "string") return; // hosted tools are dropped
  const wire = wireName(namespace, t.name);
  const custom = t.type === "custom";
  map.byWire.set(wire, { name: t.name, namespace, custom });
  if (custom) out.push(customToFunction(t, wire));
  else {
    const { namespace: _ns, ...rest } = t;
    out.push({ ...rest, name: wire });
  }
}

function rewriteInputItem(item: ResponsesInputItem): ResponsesInputItem {
  const ns = typeof item.namespace === "string" ? item.namespace : undefined;
  switch (item.type) {
    case "custom_tool_call":
      return {
        type: "function_call",
        call_id: item.call_id,
        name: wireName(ns, String(item.name)),
        arguments: JSON.stringify({ input: typeof item.input === "string" ? item.input : "" }),
      };
    case "custom_tool_call_output":
      return { type: "function_call_output", call_id: item.call_id, output: item.output };
    case "function_call": {
      const { namespace: _n, internal_chat_message_metadata_passthrough: _m, ...rest } = item;
      return ns ? { ...rest, name: wireName(ns, String(item.name)) } : rest;
    }
    default:
      return item;
  }
}

/** Flatten tools and rewrite history for a routed provider. */
export function toRoutedRequest(body: ResponsesRequest): { body: ResponsesRequest; map: ToolMap } {
  const map: ToolMap = { byWire: new Map() };
  const tools: Array<Record<string, unknown>> = [];
  for (const t of body.tools ?? []) flattenTool(t as Record<string, any>, undefined, tools, map);
  let tool_choice = body.tool_choice;
  if (tool_choice && typeof tool_choice === "object") {
    const c = tool_choice as Record<string, any>;
    if ((c.type === "custom" || c.type === "function") && typeof c.name === "string")
      tool_choice = { type: "function", name: wireName(c.namespace, c.name) };
  }
  const input = Array.isArray(body.input) ? body.input.map(rewriteInputItem) : body.input;
  const next: ResponsesRequest = { ...body, input, tool_choice };
  if (tools.length) next.tools = tools;
  else delete next.tools;
  return { body: next, map };
}

/** Recover the freeform text from `{"input": "..."}` arguments (tolerating models that skip the wrapper). */
export function unwrapFreeform(args: string): string {
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && typeof v.input === "string") return v.input;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const strings = Object.values(v).filter((x) => typeof x === "string") as string[];
      if (strings.length === 1) return strings[0]!;
    }
  } catch {
    // not JSON: treat as raw input
  }
  return args;
}

/**
 * Freeform tools Codex routes internally even when absent from the request's tools array.
 * In code-mode (`exec` grammar) `apply_patch` is folded into the exec grammar, so routed
 * models legitimately emit `apply_patch` calls that must still arrive as custom_tool_call.
 */
const IMPLICIT_FREEFORM = new Set(["apply_patch"]);

/** Map one output item back to what Codex declared. */
export function restoreItem(item: Record<string, any>, map: ToolMap): Record<string, any> {
  if (item?.type !== "function_call") return item;
  const info = map.byWire.get(item.name);
  if (!info) {
    if (IMPLICIT_FREEFORM.has(item.name)) {
      const { arguments: args, name: _n, ...rest } = item;
      return { ...rest, type: "custom_tool_call", input: unwrapFreeform(String(args ?? "")) };
    }
    return item;
  }
  const ns = info.namespace ? { namespace: info.namespace } : {};
  if (info.custom) {
    const { arguments: args, name: _n, ...rest } = item;
    return { ...rest, type: "custom_tool_call", name: info.name, ...ns, input: unwrapFreeform(String(args ?? "")) };
  }
  return { ...item, name: info.name, ...ns };
}

/**
 * Rewrite a Responses SSE stream: function_call items for custom/namespaced tools become the declared shape.
 * Argument delta events for custom calls are replaced by custom_tool_call_input events.
 */
export function restoreStream(res: Response, map: ToolMap): Response {
  if (!res.ok || !res.body || map.byWire.size === 0) return res;
  const customItems = new Set<string>();
  const src = res.body;
  const encoder = new TextEncoder();
  let seq = 0;
  const emit = (ev: Record<string, any>) => {
    ev.sequence_number = seq++;
    return encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of parseSse(src)) {
          if (frame.data === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            continue;
          }
          let ev: Record<string, any>;
          try {
            ev = JSON.parse(frame.data);
          } catch {
            continue;
          }
          const t = ev.type as string;
          if ((t === "response.output_item.added" || t === "response.output_item.done") && ev.item) {
            const restored = restoreItem(ev.item, map);
            if (restored.type === "custom_tool_call") {
              customItems.add(restored.id);
              if (t === "response.output_item.done")
                controller.enqueue(
                  emit({ type: "response.custom_tool_call_input.done", item_id: restored.id, output_index: ev.output_index, input: restored.input }),
                );
              if (t === "response.output_item.added") restored.input = "";
            }
            ev.item = restored;
          } else if (t === "response.function_call_arguments.delta" || t === "response.function_call_arguments.done") {
            if (customItems.has(ev.item_id)) continue; // input is emitted whole on item done
          } else if (ev.response && Array.isArray(ev.response.output)) {
            ev.response.output = ev.response.output.map((i: Record<string, any>) => restoreItem(i, map));
          }
          controller.enqueue(emit(ev));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return src.cancel(reason);
    },
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(stream, { status: res.status, headers });
}
