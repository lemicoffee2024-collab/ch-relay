// Responses `input` -> neutral conversation turns, with tool call / result pairing repaired
// so every translated wire (Chat Completions, Anthropic Messages) gets a well-formed history.

import type { ResponsesRequest } from "../../types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export type UserPart = { type: "text"; text: string } | { type: "image"; url: string; detail?: string };

export interface HistoryCall {
  callId: string;
  name: string;
  namespace?: string;
  custom: boolean;
  /** JSON arguments string (custom tools: JSON {"input": ...}). */
  arguments: string;
}

export type Turn =
  | { kind: "system"; text: string }
  | { kind: "user"; parts: UserPart[] }
  | { kind: "assistant"; text: string; reasoning: string; calls: HistoryCall[] }
  | { kind: "tool_result"; callId: string; name: string; text: string; images: string[]; synthetic?: boolean };

export const MISSING_RESULT_TEXT = "[ch-relay] no tool result was recorded for this call; its execution status is unknown.";

function imageUrlOf(p: Obj): string | undefined {
  const u = p.image_url;
  if (typeof u === "string") return u;
  if (isObj(u) && typeof u.url === "string") return u.url;
  return undefined;
}

function contentParts(content: unknown): UserPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: UserPart[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      out.push({ type: "text", text: p });
      continue;
    }
    if (!isObj(p)) continue;
    if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "input_image" || p.type === "image_url") {
      const url = imageUrlOf(p);
      if (url) out.push({ type: "image", url, ...(typeof p.detail === "string" ? { detail: p.detail } : {}) });
    } else if (p.type === "input_file") {
      out.push({ type: "text", text: `[file: ${String(p.filename ?? "attachment")}]` });
    } else if (p.type === "refusal" && typeof p.refusal === "string") {
      out.push({ type: "text", text: p.refusal });
    }
  }
  return out;
}

function textOf(parts: UserPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function outputOf(output: unknown): { text: string; images: string[] } {
  if (typeof output === "string") return { text: output, images: [] };
  if (Array.isArray(output)) {
    const parts = contentParts(output);
    return {
      text: textOf(parts),
      images: parts.filter((p): p is { type: "image"; url: string } => p.type === "image").map((p) => p.url),
    };
  }
  if (isObj(output) && typeof output.content === "string") return { text: output.content, images: [] };
  return { text: output == null ? "" : JSON.stringify(output), images: [] };
}

function reasoningText(item: Obj): string {
  const chunks: string[] = [];
  if (Array.isArray(item.content)) {
    for (const c of item.content) if (isObj(c) && typeof c.text === "string") chunks.push(c.text);
  }
  if (!chunks.length && Array.isArray(item.summary)) {
    for (const s of item.summary) if (isObj(s) && typeof s.text === "string") chunks.push(s.text);
  }
  return chunks.join("\n");
}

/** Parse Responses input items into raw turns (no pairing repair yet). */
export function parseInput(body: ResponsesRequest): Turn[] {
  const items: unknown[] =
    typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : (body.input ?? []);
  const turns: Turn[] = [];
  type AssistantTurn = Extract<Turn, { kind: "assistant" }>;
  let acc = null as AssistantTurn | null;
  const cur = () => acc as AssistantTurn | null;
  const closeAcc = () => {
    if (acc && (acc.text || acc.calls.length || acc.reasoning)) turns.push(acc);
    acc = null;
  };
  const openAcc = () => (acc ??= { kind: "assistant", text: "", reasoning: "", calls: [] });

  for (const raw of items) {
    if (!isObj(raw)) continue;
    const type = raw.type ?? (typeof raw.role === "string" ? "message" : undefined);
    switch (type) {
      case "message": {
        const role = raw.role;
        if (role === "assistant") {
          if (cur()?.calls.length) closeAcc();
          const a = openAcc();
          a.text += textOf(contentParts(raw.content));
        } else {
          closeAcc();
          const parts = contentParts(raw.content);
          if (role === "system" || role === "developer") {
            const text = textOf(parts);
            if (text) turns.push({ kind: "system", text });
          } else if (parts.length) {
            turns.push({ kind: "user", parts });
          }
        }
        break;
      }
      case "reasoning": {
        const c0 = cur();
        if (c0 && (c0.calls.length || c0.text)) closeAcc();
        const text = reasoningText(raw);
        const a = openAcc();
        if (text) a.reasoning += (a.reasoning ? "\n" : "") + text;
        break;
      }
      case "function_call": {
        const a = openAcc();
        a.calls.push({
          callId: String(raw.call_id ?? raw.id ?? `call_${crypto.randomUUID().slice(0, 8)}`),
          name: String(raw.name ?? "tool"),
          ...(typeof raw.namespace === "string" && raw.namespace !== "functions" ? { namespace: raw.namespace } : {}),
          custom: false,
          arguments: typeof raw.arguments === "string" && raw.arguments.trim() ? raw.arguments : "{}",
        });
        break;
      }
      case "custom_tool_call": {
        const a = openAcc();
        a.calls.push({
          callId: String(raw.call_id ?? raw.id ?? `call_${crypto.randomUUID().slice(0, 8)}`),
          name: String(raw.name ?? "tool"),
          ...(typeof raw.namespace === "string" && raw.namespace !== "functions" ? { namespace: raw.namespace } : {}),
          custom: true,
          arguments: JSON.stringify({ input: typeof raw.input === "string" ? raw.input : "" }),
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        closeAcc();
        const { text, images } = outputOf(raw.output);
        turns.push({ kind: "tool_result", callId: String(raw.call_id ?? ""), name: "", text, images });
        break;
      }
      default:
        // web_search_call, local_shell_call, compaction, item_reference, ... have no translated form.
        break;
    }
  }
  closeAcc();
  return turns;
}

/**
 * Repair call/result pairing:
 * - a call without a recorded output gets a placeholder result right after its assistant turn;
 * - an output without a preceding call gets a synthesized assistant call (`arguments: "{}"`);
 * - user/system turns that arrive while results are still pending are moved after the results.
 */
export function pairToolResults(turns: Turn[]): Turn[] {
  const names = new Map<string, string>();
  for (const t of turns) if (t.kind === "assistant") for (const c of t.calls) names.set(c.callId, c.name);

  const out: Turn[] = [];
  let pending: HistoryCall[] = [];
  let deferred: Turn[] = [];
  const release = () => {
    out.push(...deferred);
    deferred = [];
  };
  const flushPending = () => {
    for (const c of pending) {
      out.push({ kind: "tool_result", callId: c.callId, name: c.name, text: MISSING_RESULT_TEXT, images: [], synthetic: true });
    }
    pending = [];
    release();
  };

  for (const t of turns) {
    if (t.kind === "assistant") {
      flushPending();
      out.push(t);
      pending = [...t.calls];
    } else if (t.kind === "tool_result") {
      const idx = pending.findIndex((c) => c.callId === t.callId);
      if (idx >= 0) {
        out.push({ ...t, name: pending[idx]!.name });
        pending.splice(idx, 1);
        if (!pending.length) release();
      } else {
        flushPending();
        const callId = t.callId || `call_orphan_${out.length}`;
        const name = names.get(callId) ?? "tool_result";
        out.push({ kind: "assistant", text: "", reasoning: "", calls: [{ callId, name, custom: false, arguments: "{}" }] });
        out.push({ ...t, callId, name });
      }
    } else if (pending.length) {
      deferred.push(t);
    } else {
      out.push(t);
    }
  }
  flushPending();
  return out;
}

export function buildTurns(body: ResponsesRequest): Turn[] {
  return pairToolResults(parseInput(body));
}
