import { getDb } from "./db.ts";
import { protectText, unprotectText } from "../crypto/dpapi.ts";
import type { ProviderId } from "../types.ts";

interface Row {
  alias: string;
  provider: string;
  wire: string;
}

const cache = new Map<string, { provider: ProviderId; wire: string }>();

function genAlias(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return "ch/" + Array.from(b, (x) => (x % 36).toString(36)).join("");
}

/** Existing alias row for a wire model, if one was ever created — read-only. */
export function existingAlias(provider: ProviderId, wire: string): string | null {
  const rows = getDb().query("SELECT alias, provider, wire FROM model_alias").all() as Row[];
  for (const r of rows) {
    if (unprotectText(r.provider) === provider && unprotectText(r.wire) === wire) return r.alias;
  }
  return null;
}

/** Opaque catalog slug for a wire model; persisted in db so catalogs stay stable across syncs. */
export function aliasFor(provider: ProviderId, wire: string): string {
  const rows = getDb().query("SELECT alias, provider, wire FROM model_alias").all() as Row[];
  for (const r of rows) {
    if (unprotectText(r.provider) === provider && unprotectText(r.wire) === wire) return r.alias;
  }
  const alias = genAlias();
  getDb()
    .query("INSERT INTO model_alias(alias, provider, wire) VALUES (?, ?, ?)")
    .run(alias, protectText(provider), protectText(wire));
  return alias;
}

/** Resolve an opaque alias to its provider + upstream wire model. */
export function resolveAlias(slug: string): { provider: ProviderId; wire: string } | null {
  const hit = cache.get(slug);
  if (hit) return hit;
  const r = getDb().query("SELECT provider, wire FROM model_alias WHERE alias = ?").get(slug) as Row | null;
  if (!r) return null;
  const out = { provider: unprotectText(r.provider) as ProviderId, wire: unprotectText(r.wire) };
  cache.set(slug, out);
  return out;
}
