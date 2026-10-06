// Reasoning replay store keyed by tool call id.
// Codex echoes our reasoning items back as summaries, but those can be dropped (compaction,
// model switch, older histories) and never carry Anthropic thinking signatures, so the
// assistant reasoning that preceded each call is also kept here.

import { kvGet, kvSet } from "../../store/db.ts";

const NS = "opencode-reasoning";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ThinkingBlock {
  thinking: string;
  signature?: string;
}

export interface StoredReasoning {
  text: string;
  /** Anthropic-wire thinking blocks (with signatures) in upstream order. */
  blocks?: ThinkingBlock[];
}

export function storeReasoning(callIds: string[], value: StoredReasoning): void {
  if (!value.text && !value.blocks?.length) return;
  const json = JSON.stringify(value);
  for (const id of callIds) {
    try {
      kvSet(NS, id, json, TTL_MS);
    } catch {
      // cache is best effort
    }
  }
}

export function loadReasoning(callId: string): StoredReasoning | null {
  try {
    const v = kvGet(NS, callId);
    return v ? (JSON.parse(v) as StoredReasoning) : null;
  } catch {
    return null;
  }
}

/** Joined unique reasoning text recorded for any of these calls. */
export function reasoningForCalls(callIds: string[]): string {
  const texts = new Set<string>();
  for (const id of callIds) {
    const r = loadReasoning(id);
    if (r?.text) texts.add(r.text);
  }
  return [...texts].join("\n");
}
