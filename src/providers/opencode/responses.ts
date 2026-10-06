// Responses wire (stateless passthrough) for OpenCode models served on /responses.

import type { ResponsesRequest, Usage } from "../../types.ts";
import { parseSse } from "../../lib/sse.ts";
import { clampEffort, metaFor } from "./models.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Top-level fields forwarded upstream; everything else (service_tier, client_metadata, ...) is dropped. */
const ALLOWED_FIELDS = [
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "include",
  "prompt_cache_key",
  "max_output_tokens",
  "temperature",
  "top_p",
];

const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "image_generation",
  "local_shell",
  "file_search",
  "computer_use_preview",
  "code_interpreter",
  "tool_search",
  "mcp",
]);

export interface ResponsesPrepOptions {
  /** Drop every reasoning input item (retry after an upstream rejection of replayed reasoning). */
  dropReasoning?: boolean;
}

export interface NameMapping {
  /** flattened wire name -> {name, namespace} for namespaced tools. */
  names: Map<string, { name: string; namespace: string }>;
}

/**
 * Build the upstream body: stateless (no previous_response_id, store=false, full input),
 * item ids stripped, hosted tools removed, namespace groups flattened.
 */
export function buildResponsesRequest(
  body: ResponsesRequest,
  model: string,
  effort: string | undefined,
  opts: ResponsesPrepOptions = {},
): { request: Obj; mapping: NameMapping } {
  const request: Obj = {};
  for (const k of ALLOWED_FIELDS) if (body[k] !== undefined) request[k] = structuredClone(body[k]);
  request.model = model;
  request.store = false;
  request.stream = true;

  const mapping: NameMapping = { names: new Map() };
  const nsName = (ns: string, name: string) => `${ns}__${name}`;

  if (Array.isArray(request.tools)) {
    const flat: Obj[] = [];
    for (const t of request.tools as Obj[]) {
      if (!isObj(t) || HOSTED_TOOL_TYPES.has(String(t.type))) continue;
      if (t.type === "namespace" && Array.isArray(t.tools)) {
        const ns = String(t.name ?? "");
        for (const c of t.tools as Obj[]) {
          if (!isObj(c) || (c.type !== "function" && c.type !== "custom")) continue;
          if (ns === "functions" || !ns) flat.push(c);
          else {
            const wire = nsName(ns, String(c.name));
            mapping.names.set(wire, { name: String(c.name), namespace: ns });
            flat.push({ ...c, name: wire });
          }
        }
        continue;
      }
      if (t.type === "function" || t.type === "custom") flat.push(t);
    }
    if (flat.length) request.tools = flat;
    else {
      delete request.tools;
      delete request.tool_choice;
      delete request.parallel_tool_calls;
    }
  }

  if (Array.isArray(request.input)) {
    const out: unknown[] = [];
    for (const raw of request.input as unknown[]) {
      if (!isObj(raw)) {
        out.push(raw);
        continue;
      }
      const item: Obj = { ...raw };
      if (item.type === "reasoning") {
        // Only upstream-issued encrypted reasoning can be replayed; our translated summaries cannot.
        if (opts.dropReasoning || typeof item.encrypted_content !== "string") continue;
      }
      if (item.type === "item_reference" || item.type === "compaction") continue;
      if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.namespace === "string") {
        if (item.namespace !== "functions") item.name = nsName(item.namespace, String(item.name));
        delete item.namespace;
      }
      // store=false: upstream cannot resolve server-side item ids.
      delete item.id;
      out.push(item);
    }
    request.input = out;
  }

  if (!opts.dropReasoning && Array.isArray(request.include)) {
    request.include = (request.include as unknown[]).filter((x) => x === "reasoning.encrypted_content");
    if (!(request.include as unknown[]).length) delete request.include;
  } else delete request.include;

  const levels = metaFor(model).reasoningLevels;
  if (effort && levels.length) {
    const r: Obj = isObj(request.reasoning) ? { ...request.reasoning } : {};
    r.effort = clampEffort(effort, levels);
    request.reasoning = r;
  } else if (isObj(request.reasoning)) {
    const { effort: _e, ...rest } = request.reasoning;
    if (Object.keys(rest).length) request.reasoning = rest;
    else delete request.reasoning;
  }
  return { request, mapping };
}

export function responsesUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const id = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const od = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cachedInputTokens: n(id.cached_tokens),
    reasoningOutputTokens: n(od.reasoning_tokens),
  };
}

function remapItem(item: unknown, mapping: NameMapping): unknown {
  if (!isObj(item)) return item;
  if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.name === "string") {
    const hit = mapping.names.get(item.name);
    if (hit) return { ...item, name: hit.name, namespace: hit.namespace };
  }
  return item;
}

export interface PassthroughResult {
  usage?: Usage;
  status: "completed" | "incomplete" | "failed" | "truncated";
  error?: string;
  firstTokenAt?: number;
}

/**
 * Re-emit the upstream Responses SSE stream, side-scanning usage and the terminal status.
 * Namespaced tool names are mapped back; a stream without a terminal event gets a synthesized
 * `response.failed` so Codex sees a clear error.
 */
export async function* passthroughStream(
  body: ReadableStream<Uint8Array>,
  mapping: NameMapping,
  result: PassthroughResult,
  model: string,
): AsyncGenerator<string> {
  let responseId: string | undefined;
  let seq = 0;
  result.status = "truncated";
  for await (const frame of parseSse(body)) {
    if (frame.data === "[DONE]") continue;
    let ev: Obj;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const type = String(ev.type ?? frame.event ?? "");
    if (typeof ev.sequence_number === "number") seq = ev.sequence_number + 1;
    if (!result.firstTokenAt && /\.delta$/.test(type)) result.firstTokenAt = Date.now();
    const resp = isObj(ev.response) ? ev.response : undefined;
    if (resp && typeof resp.id === "string") responseId ??= resp.id;
    if (mapping.names.size) {
      if (isObj(ev.item)) ev.item = remapItem(ev.item, mapping);
      if (resp && Array.isArray(resp.output)) resp.output = resp.output.map((o) => remapItem(o, mapping));
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      result.usage = responsesUsage(resp?.usage);
      result.status = type === "response.completed" ? "completed" : type === "response.incomplete" ? "incomplete" : "failed";
      if (type === "response.failed") {
        const err = isObj(resp?.error) ? resp.error : {};
        result.error = String(err.message ?? "upstream response failed");
      }
    } else if (type === "error") {
      result.status = "failed";
      result.error = String(ev.message ?? (isObj(ev.error) ? ev.error.message : "upstream error"));
    }
    yield `event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
    if (result.status !== "truncated") return;
  }
  if (result.status === "truncated") {
    result.error = "upstream stream ended before completion";
    const response = {
      id: responseId ?? `resp_${crypto.randomUUID().replace(/-/g, "")}`,
      object: "response",
      status: "failed",
      model,
      output: [],
      error: { code: "stream_truncated", message: result.error },
    };
    yield `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: seq, response })}\n\n`;
  }
}
