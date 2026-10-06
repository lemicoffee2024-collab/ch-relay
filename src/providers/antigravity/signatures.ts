// Thought-signature replay. Gemini requires the thoughtSignature it attached to a functionCall
// to come back on that call in later turns; Codex does not echo `extra_content`, so we keep the
// signatures in the kv store (1h TTL) keyed by call_id and by session + call identity.
import { createHash } from "node:crypto";
import { getDb, kvGet, kvSet } from "../../store/db.ts";

export const SIG_TTL_MS = 60 * 60 * 1000;
export const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

const NS_CALL = "agy.sig.call";
const NS_FC = "agy.sig.fc";

/** Real signatures are opaque base64 blobs (≥16 chars) — never our sentinel or foreign ids. */
export function isValidSignature(sig: unknown): sig is string {
  if (typeof sig !== "string" || sig.length < 16) return false;
  if (sig === THOUGHT_SIGNATURE_BYPASS) return false;
  if (/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|toolu|tool|func|function)[-_]/i.test(sig)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(sig);
}

/** Signature carried by a Gemini response part (any of the known spellings). */
export function partSignature(part: Record<string, unknown>): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct) return direct;
  const nested = (part.extra_content as { google?: { thought_signature?: unknown } } | undefined)?.google?.thought_signature;
  return typeof nested === "string" && nested ? nested : undefined;
}

function sha(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(`${p.length}\0${p}`);
  return h.digest("hex");
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function sessionScope(wireModel: string, sessionId: string): string {
  return sha(wireModel, sessionId).slice(0, 32);
}

function fcKey(scope: string, name: string, args: unknown): string {
  return `${scope}:${sha(name, canonicalJson(args ?? {}))}`;
}

interface StoredSig {
  sig: string;
  model: string;
}

/** Remember the signature of a function call emitted to Codex. */
export function rememberSignature(opts: { callId: string; wireModel: string; sessionId: string; name: string; args: unknown; sig: string }): void {
  if (!isValidSignature(opts.sig)) return;
  const value = JSON.stringify({ sig: opts.sig, model: opts.wireModel } satisfies StoredSig);
  kvSet(NS_CALL, opts.callId, value, SIG_TTL_MS);
  kvSet(NS_FC, fcKey(sessionScope(opts.wireModel, opts.sessionId), opts.name, opts.args), value, SIG_TTL_MS);
}

function read(ns: string, key: string): StoredSig | null {
  const raw = kvGet(ns, key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredSig;
    return isValidSignature(v.sig) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Look up a signature for a historical call. `useSessionCache` is false for Claude (only exact
 * call-id hits recorded for the same wire model are reused there).
 */
export function lookupSignature(opts: {
  callId: string;
  wireModel: string;
  sessionId: string;
  name: string;
  args: unknown;
  useSessionCache: boolean;
}): string | undefined {
  const byCall = read(NS_CALL, opts.callId);
  if (byCall && (opts.useSessionCache || byCall.model === opts.wireModel)) return byCall.sig;
  if (!opts.useSessionCache) return undefined;
  return read(NS_FC, fcKey(sessionScope(opts.wireModel, opts.sessionId), opts.name, opts.args))?.sig;
}

/** Drop all session-scoped signatures (after an upstream signature rejection). */
export function clearSessionSignatures(wireModel: string, sessionId: string, callIds: string[] = []): void {
  getDb().query("DELETE FROM kv WHERE ns = ? AND key LIKE ?").run(NS_FC, `${sessionScope(wireModel, sessionId)}:%`);
  for (const id of callIds) getDb().query("DELETE FROM kv WHERE ns = ? AND key = ?").run(NS_CALL, id);
}

export function isSignatureError(text: string): boolean {
  return /signature|thought_signature|thoughtSignature/i.test(text);
}
