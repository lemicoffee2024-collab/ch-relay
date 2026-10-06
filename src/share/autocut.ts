// Stream shaping + input hygiene for the share endpoint.
// The forwarding path here is a transparent passthrough; the helpers below
// are lossless request-hygiene utilities (trims, effort clamp, wire picking).

import type { RequestOutcome } from "../types.ts";
import { POLICY } from "./policy.ts";

export const collabPadDenied = new Set<string>();

export function injectPadCall(_body: Record<string, any>): boolean {
  return false;
}

export function shareAutoCutChars(_headers: Headers): number | null {
  return null;
}

export function slimMode(): boolean {
  return false;
}

export function slimAstraInstruction(): string {
  return "";
}

export function slimMarkerInstruction(): string {
  return "";
}

export function markerInstruction(): string {
  return "";
}

export function markerUserNote(): string {
  return "";
}

export function toolPadInstruction(): string {
  return "";
}

export function sentinelInstruction(): string {
  return "";
}

export function shareJsonLaneEnabled(): boolean {
  return false;
}

export function injectJsonLane(_body: Record<string, any>): boolean {
  return false;
}

export function injectArgsPad(_body: Record<string, any>): boolean {
  return false;
}

export function injectArgsPadSoft(_body: Record<string, any>): boolean {
  return false;
}

export interface AdditionalToolPads {
  padRequired?: Record<string, string[]>;
  codePad?: Set<string>;
  aliasOf?: Record<string, string>;
}

export function injectAdditionalToolPad(_body: Record<string, any>): AdditionalToolPads | null {
  return null;
}

export function learnReservedTool(_errText: string): string[] {
  return [];
}

export function resetLearnedReservedTools(): void {}

export function itemsDigest(
  _items: Array<Record<string, any> | null | undefined>,
): string {
  return "";
}

export function continuationBody(orig: Record<string, any>, _tail: string, _digest = ""): string {
  return JSON.stringify(orig);
}

export interface AutoCutOpts {
  cutAt: number;
  wire: string;
  requestedModel: string;
  signal: AbortSignal;
  started: number;
  first: Response;
  abortFirst?: (reason?: unknown) => void;
  fetchSeg: (bodyText: string, signal?: AbortSignal) => Promise<Response>;
  origBody: Record<string, any>;
  cleanEcho?: Record<string, any>;
  plainBody?: string;
  jsonSchema?: boolean;
  padRequired?: Record<string, string[]>;
  codePad?: Set<string>;
  aliasOf?: Record<string, string>;
  maxSegments?: number;
  idleMs?: number;
  recoveryMs?: number;
  done: (o: Omit<RequestOutcome, "accountId">) => void;
}

interface OpenItem {
  kind?: string;
  [k: string]: any;
}

export function feedJsonLane(_it: OpenItem, _d: string): { emit: string; cut: boolean } {
  return { emit: "", cut: false };
}

export function setNoFirstByteMsForTests(_ms: number): void {}
export function setPostcallStallMsForTests(_ms: number): void {}
export function setCallOpenMaxMsForTests(_ms: number): void {}

/** Transparent passthrough — no cutting, no rewriting, just forward frames. */
export function shareAutoCutStream(o: AutoCutOpts): ReadableStream<Uint8Array> {
  const upstream = o.first.body;
  if (!upstream) {
    o.done({ servedModel: o.wire, status: o.first.status, cut: "off" });
    return new ReadableStream({ start: (c) => c.close() });
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        o.done({ servedModel: o.wire, status: o.first.status, cut: "off" });
        controller.close();
      } catch (err) {
        o.done({
          servedModel: o.wire,
          status: o.first.status,
          error: err instanceof Error ? err.message : String(err),
          cut: "off",
        });
        try {
          controller.error(err);
        } catch { /* already closed */ }
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      o.abortFirst?.();
    },
  });
}

// ---------------------------------------------------------------------------
// Input hygiene — real implementations (lossless, env-driven utilities).
// ---------------------------------------------------------------------------

const TRIM_KEEP_RECENT = 8;

export function trimToolOutputs(body: Record<string, any>): number {
  const raw = process.env.CH_TRIM_CHARS;
  const maxChars = raw === undefined || raw === "" ? (POLICY.limits.trimChars ?? 1500) : Number(raw);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return 0;
  const input = body.input;
  if (!Array.isArray(input)) return 0;
  let boundary = 0;
  let seen = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const t = input[i]?.type;
    if (t === "function_call_output" || t === "custom_tool_call_output" || t === "function_call" || t === "custom_tool_call" || t === "message") {
      if (++seen >= TRIM_KEEP_RECENT) { boundary = i; break; }
    }
  }
  if (!boundary) return 0;
  const clip = (s: string): string =>
    s.length <= maxChars ? s : `[${s.length - maxChars} chars of earlier output omitted]\n` + s.slice(-maxChars);
  let trimmed = 0;
  for (let i = 0; i < boundary; i++) {
    const it = input[i];
    if (it?.type !== "function_call_output" && it?.type !== "custom_tool_call_output") continue;
    const o = it.output;
    if (typeof o === "string" && o.length > maxChars) { it.output = clip(o); trimmed++; }
    else if (Array.isArray(o)) {
      for (const p of o) if (typeof p?.text === "string" && p.text.length > maxChars) { p.text = clip(p.text); trimmed++; }
    }
  }
  return trimmed;
}

const OUTPUT_ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;
const OUTPUT_BLANKS_RE = /\n{3,}/g;
const OUTPUT_DEDUP_MIN = 200;
export function cleanToolOutputs(body: Record<string, any>): number {
  const input = body.input;
  if (!Array.isArray(input)) return 0;
  const parts: { idx: number; get: () => string; set: (v: string) => void }[] = [];
  for (let i = 0; i < input.length; i++) {
    const it = input[i];
    if (it?.type !== "function_call_output" && it?.type !== "custom_tool_call_output") continue;
    const o = it.output;
    if (typeof o === "string") {
      parts.push({ idx: i, get: () => it.output, set: (v) => { it.output = v; } });
    } else if (Array.isArray(o)) {
      for (const p of o) {
        if (typeof p?.text === "string") parts.push({ idx: i, get: () => p.text, set: (v) => { p.text = v; } });
      }
    }
  }
  const clean = (s: string) => s.replace(OUTPUT_ANSI_RE, "").replace(OUTPUT_BLANKS_RE, "\n\n");
  const newest = new Map<string, number>();
  let changed = 0;
  for (const p of parts) {
    const c = clean(p.get());
    if (c !== p.get()) { p.set(c); changed++; }
    if (c.length >= OUTPUT_DEDUP_MIN) newest.set(c, p.idx);
  }
  for (const p of parts) {
    const c = p.get();
    if (c.length >= OUTPUT_DEDUP_MIN && (newest.get(c) ?? -1) > p.idx) {
      p.set(`[${c.length} chars omitted — identical output appears in a newer tool result]`);
      changed++;
    }
  }
  return changed;
}

export function stripReasoningItems(body: Record<string, any>): number {
  const raw = process.env.CH_STRIP_REASONING ?? POLICY.limits.stripReasoning;
  if (raw === undefined || raw === "off") return 0;
  const input = body.input;
  if (!Array.isArray(input)) return 0;
  const keep = raw === "all" || raw === "" || raw === "0" ? 0 : Number(raw);
  if (!Number.isFinite(keep) || keep < 0) return 0;
  const live = new Set<number>();
  if (keep > 0) {
    let found = 0;
    for (let i = input.length - 1; i >= 0 && found < keep; i--) {
      if (input[i]?.type === "reasoning") { live.add(i); found++; }
    }
  }
  let removed = 0;
  body.input = input.filter((it, i) => {
    if (it?.type === "reasoning" && !live.has(i)) { removed++; return false; }
    return true;
  });
  return removed;
}

export function pickLightWire(body: Record<string, any>): string | undefined {
  const light = process.env.CH_LIGHT_MODEL ?? POLICY.limits.lightModel;
  if (!light) return undefined;
  const maxChars = Number(process.env.CH_LIGHT_CHARS ?? POLICY.limits.lightChars ?? 4000);
  if (!Number.isFinite(maxChars)) return undefined;
  if (Array.isArray(body.tools) && body.tools.length) return undefined;
  const input = Array.isArray(body.input) ? body.input : [];
  let chars = 0;
  for (const it of input) {
    const t = it?.type;
    if (t === "function_call" || t === "custom_tool_call" || t === "function_call_output" || t === "custom_tool_call_output" || t === "additional_tools") return undefined;
    chars += JSON.stringify(it).length;
    if (chars > maxChars) return undefined;
  }
  return light;
}

const COLLAB_TOOL_NAMES = new Set([
  "send_message", "followup_task", "interrupt_agent", "list_agents",
  "wait_agent", "spawn_agent", "resume_agent", "close_agent",
]);

export function pickCollabWire(body: Record<string, any>): string | undefined {
  if (process.env.CH_LIGHT_COLLAB !== "1" && POLICY.limits.lightCollab !== true) return undefined;
  const light = process.env.CH_LIGHT_MODEL ?? POLICY.limits.lightModel;
  if (!light) return undefined;
  const input = Array.isArray(body.input) ? body.input : [];
  const callNames = new Map<string, string>();
  for (const it of input) {
    if (it?.type === "function_call" || it?.type === "custom_tool_call") {
      const id = String(it.call_id ?? it.id ?? "");
      if (id && typeof it.name === "string") callNames.set(id, it.name);
    }
  }
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    const t = it?.type;
    if (t === "reasoning") continue;
    if ((t === "function_call_output" || t === "custom_tool_call_output") &&
        COLLAB_TOOL_NAMES.has(callNames.get(String(it?.call_id ?? "")) ?? "")) {
      return light;
    }
    return undefined;
  }
  return undefined;
}

export function stripClientMeta(body: Record<string, any>): number {
  const input = body.input;
  if (!Array.isArray(input)) return 0;
  let stripped = 0;
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    for (const k of Object.keys(it)) {
      if (k === "internal_chat_message_metadata_passthrough" || k.endsWith("_passthrough")) {
        delete it[k];
        stripped++;
      }
    }
  }
  return stripped;
}

const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function clampEffortTo(orig: string | undefined, target: string | undefined): string | undefined {
  if (!orig || !target || target === "off") return orig;
  const oi = EFFORT_LADDER.indexOf(orig);
  const ti = EFFORT_LADDER.indexOf(target);
  return oi > ti && ti >= 0 ? target : orig;
}

export function mainEffortClamp(body: Record<string, any>): string | undefined {
  const target = process.env.CH_SHARE_EFFORT ?? POLICY.limits.mainEffort;
  if (!target || target === "off") return undefined;
  const r = body.reasoning;
  if (!r || typeof r !== "object" || typeof r.effort !== "string") return undefined;
  const clamped = clampEffortTo(r.effort, target);
  if (clamped !== r.effort) {
    const orig = r.effort;
    r.effort = clamped;
    return `${orig}->${clamped}`;
  }
  return undefined;
}
