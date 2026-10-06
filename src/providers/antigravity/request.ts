// Translate an OpenAI Responses request (as sent by Codex) into a Cloud Code Assist envelope.
import { createHash, randomBytes } from "node:crypto";
import type { ResponsesInputItem, ResponsesRequest } from "../../types.ts";
import { maxOutputTokens, modelFamily, resolveWireModel } from "./models.ts";
import { ToolNameCodec, sanitizeToolSchema } from "./schema.ts";
import { THOUGHT_SIGNATURE_BYPASS, isValidSignature, lookupSignature } from "./signatures.ts";

type Json = Record<string, unknown>;
type Part = Json;
interface Content {
  role: "user" | "model";
  parts: Part[];
}

const EMPTY = "(empty)";
const EMPTY_TOOL_OUTPUT = "(empty tool output)";
const MISSING_TOOL_RESULT = "[missing tool_result for this tool_use in history]";
const CLAUDE_SDK_PARAGRAPH = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export interface BuiltRequest {
  wire: string;
  thinkingLevel?: string;
  family: "gem" | "cla";
  sessionId: string;
  /** Inner `request` object of the CCA envelope. */
  request: Json;
  codec: ToolNameCodec;
  /** Call ids whose signature came from the replay store (forgotten on signature errors). */
  injectedCallIds: string[];
}

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

/** "-" + (sha256(preimage)[0..8] as BE uint64 & 0x7FFF…); must stay stable across turns. */
export function sessionIdFrom(preimage: string | undefined): string {
  const digest = preimage ? createHash("sha256").update(preimage, "utf8").digest() : randomBytes(8);
  return `-${(digest.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  return m ? { mime: m[1]!, data: m[2]! } : null;
}

function imageUrlOf(p: Json): string | undefined {
  const u = p.image_url;
  if (typeof u === "string") return u;
  if (u && typeof u === "object" && typeof (u as Json).url === "string") return (u as Json).url as string;
  return undefined;
}

/** Convert Responses content parts into Gemini parts (text + inline images). */
function contentToParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Json;
    const t = p.type;
    if ((t === "input_text" || t === "output_text" || t === "text" || t === "summary_text") && typeof p.text === "string") {
      if (p.text) parts.push({ text: p.text });
    } else if (t === "input_image" || t === "image_url") {
      const url = imageUrlOf(p);
      if (!url) continue;
      const d = parseDataUrl(url);
      parts.push(d ? { inline_data: { mime_type: d.mime, data: d.data } } : { text: `[image: ${url}]` });
    } else if (t === "input_file") {
      const d = typeof p.file_data === "string" ? parseDataUrl(p.file_data) : null;
      if (d) parts.push({ inline_data: { mime_type: d.mime, data: d.data } });
      else parts.push({ text: `[file: ${String(p.filename ?? p.file_url ?? "attachment")}]` });
    } else if (t === "refusal" && typeof p.refusal === "string") {
      parts.push({ text: p.refusal });
    }
  }
  return parts;
}

function textOf(content: unknown): string {
  return contentToParts(content)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Tool output → {result text, extra inline parts}. */
function toolOutput(output: unknown): { text: string; media: Part[] } {
  if (typeof output === "string") return { text: output || EMPTY_TOOL_OUTPUT, media: [] };
  if (Array.isArray(output)) {
    const parts = contentToParts(output);
    const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text as string).join("\n");
    return { text: text || EMPTY_TOOL_OUTPUT, media: parts.filter((p) => p.inline_data) };
  }
  if (output && typeof output === "object") {
    const o = output as Json;
    if (typeof o.content === "string") return { text: o.content || EMPTY_TOOL_OUTPUT, media: [] };
    if (Array.isArray(o.content)) return toolOutput(o.content);
    return { text: JSON.stringify(output), media: [] };
  }
  return { text: EMPTY_TOOL_OUTPUT, media: [] };
}

function sanitizeCallId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return s || `call_${crypto.randomUUID().slice(0, 8)}`;
}

function parseArgs(args: unknown): Json {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Json;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : { value: v };
  } catch {
    return { input: args };
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

type Entry =
  | { kind: "user"; parts: Part[] }
  | { kind: "model"; parts: Part[]; calls: Array<{ id: string; wireName: string }> }
  | { kind: "tool"; callId: string; name?: string; text: string; media: Part[] };

interface HistoryOpts {
  codec: ToolNameCodec;
  wire: string;
  sessionId: string;
  isClaude: boolean;
  injected: string[];
}

function buildHistory(items: ResponsesInputItem[], opts: HistoryOpts): { system: string[]; contents: Content[] } {
  const system: string[] = [];
  const entries: Entry[] = [];
  const modelEntry = (): Extract<Entry, { kind: "model" }> => {
    const last = entries[entries.length - 1];
    if (last?.kind === "model") return last;
    const e = { kind: "model" as const, parts: [] as Part[], calls: [] as Array<{ id: string; wireName: string }> };
    entries.push(e);
    return e;
  };
  const callNames = new Map<string, string>();

  const addCall = (callId: string, name: string, args: Json, echoed: unknown) => {
    const wireName = opts.codec.toWire(name);
    const id = sanitizeCallId(callId);
    callNames.set(callId, name);
    const part: Part = { functionCall: { name: wireName, args, id } };
    let sig = isValidSignature(echoed) ? echoed : undefined;
    if (!sig) {
      sig = lookupSignature({ callId, wireModel: opts.wire, sessionId: opts.sessionId, name, args, useSessionCache: !opts.isClaude });
      if (sig) opts.injected.push(callId);
    }
    if (sig) part.thoughtSignature = sig;
    const m = modelEntry();
    m.parts.push(part);
    m.calls.push({ id, wireName });
  };

  for (const item of items) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const role = String(item.role ?? "user");
      if (role === "system") {
        const t = textOf(item.content);
        if (t) system.push(t);
      } else if (role === "assistant") {
        const parts = contentToParts(item.content).filter((p) => typeof p.text === "string");
        if (parts.length) modelEntry().parts.push(...parts);
      } else {
        const parts = contentToParts(item.content);
        entries.push({ kind: "user", parts: parts.length ? parts : [{ text: EMPTY }] });
      }
    } else if (type === "function_call") {
      const echoed = (item.extra_content as { google?: { thought_signature?: unknown } } | undefined)?.google?.thought_signature;
      addCall(String(item.call_id ?? item.id ?? ""), String(item.name ?? ""), parseArgs(item.arguments), echoed);
    } else if (type === "custom_tool_call") {
      addCall(String(item.call_id ?? item.id ?? ""), String(item.name ?? ""), { input: String(item.input ?? "") }, undefined);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = String(item.call_id ?? "");
      const o = toolOutput(item.output);
      entries.push({ kind: "tool", callId: sanitizeCallId(callId), name: callNames.get(callId), text: o.text, media: o.media });
    }
    // reasoning, web_search_call, local_shell_call, ... are not replayed.
  }

  const contents: Content[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === "user") {
      contents.push({ role: "user", parts: e.parts });
    } else if (e.kind === "tool") {
      // Orphan tool output (no adjacent call): keep it as text so context is not lost.
      contents.push({ role: "user", parts: [{ text: `[tool_result without adjacent tool_use: ${e.name ?? e.callId}]\n${e.text}` }, ...e.media] });
    } else {
      if (!e.parts.length) continue;
      contents.push({ role: "model", parts: e.parts });
      if (!e.calls.length) continue;
      const results = new Map<string, Extract<Entry, { kind: "tool" }>>();
      const orphans: Array<Extract<Entry, { kind: "tool" }>> = [];
      let j = i + 1;
      const wanted = new Set(e.calls.map((c) => c.id));
      while (j < entries.length && entries[j]!.kind === "tool") {
        const t = entries[j] as Extract<Entry, { kind: "tool" }>;
        if (wanted.has(t.callId) && !results.has(t.callId)) results.set(t.callId, t);
        else orphans.push(t);
        j++;
      }
      const parts: Part[] = [];
      for (const c of e.calls) {
        const r = results.get(c.id);
        parts.push({ functionResponse: { name: c.wireName, id: c.id, response: { result: r ? r.text : MISSING_TOOL_RESULT } } });
        if (r) parts.push(...r.media);
      }
      for (const o of orphans) parts.push({ text: `[tool_result without adjacent tool_use: ${o.name ?? o.callId}]\n${o.text}` }, ...o.media);
      contents.push({ role: "user", parts });
      i = j - 1;
    }
  }
  const last = contents[contents.length - 1];
  if (!last || last.role === "model") contents.push({ role: "user", parts: [{ text: "(continue)" }] });
  return { system, contents };
}

/** Gemini needs a (real or sentinel) signature on the first functionCall of every model turn. */
export function applySignatureFallback(wire: string, contents: Content[]): void {
  if (!/^gemini[-.\d]/i.test(wire)) return;
  for (const c of contents) {
    if (c.role !== "model") continue;
    const first = c.parts.find((p) => p.functionCall);
    if (first && !isValidSignature(first.thoughtSignature)) first.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
  }
}

/** Claude path: drop unsigned thought parts and any signature on non-model turns. */
function sanitizeClaudeSignatures(contents: Content[]): void {
  for (const c of contents) {
    if (c.role !== "model") {
      for (const p of c.parts) {
        delete p.thoughtSignature;
        delete p.thought_signature;
      }
    } else {
      c.parts = c.parts.filter((p) => !(p.thought === true && !isValidSignature(p.thoughtSignature)));
    }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildTools(tools: ResponsesRequest["tools"], codec: ToolNameCodec): Json[] {
  const decls: Json[] = [];
  for (const t of tools ?? []) {
    const name = typeof t.name === "string" ? t.name : undefined;
    if (!name) continue;
    if (t.type === "function") {
      decls.push({
        name: codec.toWire(name),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        parameters: sanitizeToolSchema(t.parameters),
      });
    } else if (t.type === "custom") {
      // Freeform tools (e.g. apply_patch) become a function with a single string argument.
      const fmt = t.format as { type?: string; syntax?: string; definition?: string } | undefined;
      let description = typeof t.description === "string" ? t.description : "";
      if (fmt?.definition && fmt.definition.length <= 8000) {
        description += `\n\nThe \`input\` argument must follow this ${fmt.syntax ?? "grammar"} grammar:\n${fmt.definition}`;
      }
      decls.push({
        name: codec.toWire(name),
        description: description.trim(),
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Raw freeform input for this tool." } },
          required: ["input"],
        },
      });
    }
  }
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

function toolConfigFor(choice: unknown, codec: ToolNameCodec): Json | undefined {
  if (choice === undefined || choice === null || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof choice === "object") {
    const c = choice as Json;
    const name = typeof c.name === "string" ? c.name : typeof (c.function as Json | undefined)?.name === "string" ? ((c.function as Json).name as string) : undefined;
    if (name) return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [codec.toWire(name)] } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function firstUserText(items: ResponsesInputItem[]): string | undefined {
  for (const it of items) {
    if ((it.type ?? "message") === "message" && it.role === "user") {
      const t = textOf(it.content);
      if (t) return t;
    }
  }
  return undefined;
}

export function buildCcaRequest(body: ResponsesRequest, model: string, effort: string | undefined, sessionKey: string | undefined): BuiltRequest {
  const { wire, thinkingLevel } = resolveWireModel(model, effort);
  const isClaude = /claude/i.test(wire);
  const isGemini = /^gemini-/i.test(wire);
  const items: ResponsesInputItem[] =
    typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : [];
  const sessionId = sessionIdFrom(sessionKey ? `codex-thread:${sessionKey}` : firstUserText(items));
  const codec = new ToolNameCodec();
  const injected: string[] = [];

  // Declare tools first so their wire names are allocated before history references them.
  const tools = buildTools(body.tools, codec);
  const { system, contents } = buildHistory(items, { codec, wire, sessionId, isClaude, injected });
  if (isClaude) sanitizeClaudeSignatures(contents);
  applySignatureFallback(wire, contents);

  let systemText = [body.instructions, ...system].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n\n");
  systemText = systemText.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");
  if (/^gemini-3\.[78]-flash/.test(wire)) {
    systemText = systemText
      .split("\n\n")
      .filter((p) => p.trim() !== CLAUDE_SDK_PARAGRAPH)
      .join("\n\n");
  }

  const request: Json = { contents };
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] };
  if (tools.length) {
    request.tools = tools;
    const tc = toolConfigFor(body.tool_choice, codec);
    if (tc) request.toolConfig = tc;
    if (isClaude) {
      if (body.tool_choice === "none") {
        delete request.tools;
        delete request.toolConfig;
      } else {
        const fcc = ((request.toolConfig as Json | undefined)?.functionCallingConfig ?? {}) as Json;
        request.toolConfig = { functionCallingConfig: { ...fcc, mode: "VALIDATED" } };
      }
    }
  }

  const gc: Json = {};
  const cap = maxOutputTokens(wire);
  const requested = typeof body.max_output_tokens === "number" && body.max_output_tokens > 0 ? Math.floor(body.max_output_tokens) : undefined;
  const maxOut = cap !== undefined ? Math.min(requested ?? cap, cap) : requested;
  if (maxOut) gc.maxOutputTokens = maxOut;
  if (typeof body.temperature === "number" && body.temperature >= 0) gc.temperature = Math.min(2, body.temperature);
  if (typeof body.top_p === "number" && body.top_p >= 0) gc.topP = Math.min(1, body.top_p);
  const stop = (body as Json).stop;
  if (Array.isArray(stop)) {
    const seqs = [...new Set(stop.filter((s): s is string => typeof s === "string" && s.length > 0))].slice(0, 5);
    if (seqs.length) gc.stopSequences = seqs;
  }
  if (thinkingLevel || isGemini) {
    gc.thinkingConfig = { ...(thinkingLevel ? { thinkingLevel } : {}), ...(isGemini ? { includeThoughts: true } : {}) };
  }
  const fmt = (body.text as { format?: { type?: string; schema?: unknown } } | undefined)?.format;
  if (isGemini && fmt && (fmt.type === "json_schema" || fmt.type === "json_object")) {
    gc.responseMimeType = "application/json";
    if (fmt.type === "json_schema" && fmt.schema && typeof fmt.schema === "object") gc.responseJsonSchema = fmt.schema;
  }
  if (Object.keys(gc).length) request.generationConfig = gc;
  request.sessionId = sessionId;

  return { wire, thinkingLevel, family: modelFamily(wire), sessionId, request, codec, injectedCallIds: injected };
}

export function buildEnvelope(built: BuiltRequest, project: string): Json {
  return {
    model: built.wire,
    userAgent: "antigravity",
    requestType: "agent",
    project,
    requestId: `agent-${crypto.randomUUID()}`,
    request: built.request,
  };
}

// ---------------------------------------------------------------------------
// 400 repair
// ---------------------------------------------------------------------------

export function isSchemaErrorText(t: string): boolean {
  return /(?:input[_ ]schema|json schema|function[_ ]declarations?|x-mcp-header)/i.test(t);
}

export function isThinkingErrorText(t: string): boolean {
  return /thinking[_ ]?(?:config|level)/i.test(t);
}

/**
 * Repair the inner request for a 400: open the rejected tool schema(s), drop thinkingConfig,
 * or replace replayed signatures with the sentinel. Returns true when something changed.
 */
export function repairRequest(built: BuiltRequest, errorText: string): boolean {
  const req = built.request;
  let changed = false;
  if (isThinkingErrorText(errorText)) {
    const gc = req.generationConfig as Json | undefined;
    if (gc && "thinkingConfig" in gc) {
      delete gc.thinkingConfig;
      changed = true;
    }
  }
  if (isSchemaErrorText(errorText)) {
    const decls = ((req.tools as Json[] | undefined)?.[0]?.functionDeclarations ?? []) as Json[];
    const idx = /function[_]?declarations(?:\.|\[)(\d+)/i.exec(errorText)?.[1] ?? /tools(?:\.|\[)(\d+)(?:\])?\.custom\.input_schema/i.exec(errorText)?.[1];
    const target = idx !== undefined ? decls[Number(idx)] : undefined;
    for (const d of target ? [target] : decls) d.parameters = { type: "object", properties: {} };
    if (decls.length) changed = true;
  }
  if (/signature/i.test(errorText)) {
    const contents = req.contents as Content[];
    for (const c of contents) {
      for (const p of c.parts) {
        if (p.thoughtSignature !== undefined) {
          delete p.thoughtSignature;
          changed = true;
        }
      }
    }
    applySignatureFallback(built.wire, contents);
  }
  return changed;
}
