/**
 * Remote compaction for routed (non-ChatGPT) providers.
 *
 * Codex treats every model as the built-in OpenAI provider (openai_base_url points here), so it
 * asks for remote compaction for routed models too:
 *  - v2: a normal /responses call whose input ends with {"type":"compaction_trigger"}; Codex then
 *    requires EXACTLY ONE {"type":"compaction","encrypted_content":...} output item.
 *  - v1: POST /responses/compact returning {"output":[ResponseItem...]} as replacement history.
 * Routed models can't mint OpenAI's encrypted blob, so we run the model as a summarizer and wrap
 * the text as `ocx1:` + base64(summary). The `ocx1:` envelope is shared with opencodex so threads
 * compacted there keep working. Mirrors opencodex src/responses/compaction.ts.
 */
import { parseSse, jsonError, usageToResponses } from "./lib/sse.ts";
import type { ResponsesInputItem, ResponsesRequest, Usage } from "./types.ts";

export const COMPACTION_PREFIX = "ocx1:";

export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const OPAQUE_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";
const COMPACTION_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);
const V1_RETAINED_CHARS = 20_000 * 4;

export function encodeSummary(summary: string): string {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

export function decodeSummary(blob: string): string | null {
  if (!blob.startsWith(COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(blob.slice(COMPACTION_PREFIX.length), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function userText(text: string): ResponsesInputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

export function isCompactionTrigger(body: ResponsesRequest): boolean {
  const input = body.input;
  return Array.isArray(input) && input.length > 0 && input[input.length - 1]?.type === "compaction_trigger";
}

/**
 * Rewrite replayed compaction items in `input`.
 * - routed providers: every compaction item becomes a plain user message (decoded or opaque note);
 * - ChatGPT: only our `ocx1:` items are rewritten (real OpenAI blobs must pass through untouched).
 */
export function rewriteCompactionItems(body: ResponsesRequest, routed: boolean): ResponsesRequest {
  if (!Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map((item) => {
    if (!COMPACTION_TYPES.has(String(item.type))) return item;
    const blob = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
    const decoded = decodeSummary(blob);
    if (!routed && decoded === null) return item;
    changed = true;
    return userText(decoded !== null ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_NOTE);
  });
  return changed ? { ...body, input } : body;
}

/** Build the summarizer request: history + compaction prompt, no tools. */
export function summarizerRequest(body: ResponsesRequest): ResponsesRequest {
  const input = (Array.isArray(body.input) ? body.input : []).filter((i) => i.type !== "compaction_trigger");
  const { tools: _t, tool_choice: _tc, parallel_tool_calls: _p, ...rest } = body;
  return { ...rest, input: [...input, userText(COMPACT_PROMPT)], stream: true };
}

/** Drain a provider's Responses SSE stream, returning the assistant text and usage. */
export async function collectText(res: Response): Promise<{ text: string; usage?: Usage; error?: string }> {
  if (!res.ok || !res.body) return { text: "", error: `${res.status} ${await res.text().catch(() => "")}` };
  let text = "";
  let usage: Usage | undefined;
  let error: string | undefined;
  for await (const frame of parseSse(res.body)) {
    if (frame.data === "[DONE]") break;
    let ev: any;
    try {
      ev = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (ev.type === "response.output_text.delta") text += ev.delta ?? "";
    else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      const u = ev.response?.usage;
      if (u)
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
          reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
        };
    } else if (ev.type === "response.failed" || ev.type === "error") {
      error = ev.response?.error?.message ?? ev.message ?? "compaction failed";
    }
  }
  return { text, usage, error };
}

/** v2: SSE stream carrying exactly one compaction output item. */
export function compactionV2Response(model: string, summary: string, usage?: Usage): Response {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const item = { id: `cmp_${crypto.randomUUID().replace(/-/g, "")}`, type: "compaction", encrypted_content: encodeSummary(summary) };
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`;
  const base = { id, object: "response", created_at: created, model };
  const body =
    ev("response.created", { response: { ...base, status: "in_progress", output: [] } }) +
    ev("response.output_item.added", { output_index: 0, item }) +
    ev("response.output_item.done", { output_index: 0, item }) +
    ev("response.completed", { response: { ...base, status: "completed", output: [item], usage: usageToResponses(usage) } });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

/** v1: replacement history = recent user messages (budgeted) + summary message. */
export function compactionV1Response(body: ResponsesRequest, summary: string): Response {
  const users: string[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if ((item.type !== undefined && item.type !== "message") || item.role !== "user") continue;
    const c = item.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((b: any) => ((b?.type === "input_text" || b?.type === "text") && typeof b.text === "string" ? b.text : "")).join("")
          : "";
    if (text.trim()) users.push(text);
  }
  const kept: string[] = [];
  let budget = V1_RETAINED_CHARS;
  for (let i = users.length - 1; i >= 0 && budget > 0; i--) {
    const msg = users[i]!;
    if (msg.length <= budget) {
      kept.push(msg);
      budget -= msg.length;
    } else {
      kept.push(msg.slice(msg.length - budget));
      break;
    }
  }
  kept.reverse();
  const summaryText = summary.trim() ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  return Response.json({ output: [...kept.map(userText), userText(summaryText)] });
}

export function compactionError(message: string): Response {
  return jsonError(502, `compaction failed: ${message}`, "compaction_failed");
}
