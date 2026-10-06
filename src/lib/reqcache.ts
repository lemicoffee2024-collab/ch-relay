// Short-TTL response replay cache. Identical request bodies — client retries,
// router re-asks, harness polling — replay the stored response without an
// upstream call: a genuine 100% saving, not an accounting trick.

import { createHash } from "node:crypto";
import { log } from "./log.ts";

interface Entry {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  ts: number;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 200;
const MAX_BYTES = 512 * 1024;
const HOP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

/** TTL: default 5min; CH_CACHE_MS=0/off disables the cache entirely. */
export function reqCacheTtlMs(): number {
  const v = process.env.CH_CACHE_MS;
  if (v === undefined || v === "") return 5 * 60_000;
  if (v === "off" || v === "0") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Stable key: route + caller auth hash + exact body. Retries send identical
 *  bodies, so the raw text is the strictest correct key. */
export function reqCacheKey(route: string, rawBody: string, auth: string | null): string | null {
  if (!rawBody || rawBody.length > 2 * 1024 * 1024) return null;
  const ah = auth ? createHash("sha256").update(auth).digest("hex").slice(0, 16) : "-";
  return `${route}:${ah}:${createHash("sha256").update(rawBody).digest("hex")}`;
}

export function reqCacheGet(key: string): Response | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > reqCacheTtlMs()) {
    cache.delete(key);
    return null;
  }
  log.info(`reqcache hit ${key.slice(0, 40)} ${e.body.length}B`);
  return new Response(e.body.slice(0), { status: e.status, headers: e.headers });
}

/** Transparent tee: streams bytes through while buffering; stores on clean EOF
 *  only (a cancelled or errored stream is never cached). */
export function reqCacheTap(res: Response, key: string | null): Response {
  const src = res.body;
  if (!key || !res.ok || !src || reqCacheTtlMs() <= 0) return res;
  const reader = src.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const tapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (total <= MAX_BYTES) {
          const body = new Uint8Array(total);
          let off = 0;
          for (const ch of chunks) { body.set(ch, off); off += ch.length; }
          if (cache.size >= MAX_ENTRIES) {
            const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 20);
            for (const [k] of oldest) cache.delete(k);
          }
          const h: Record<string, string> = {};
          res.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) h[k] = v; });
          cache.set(key, { status: res.status, headers: h, body, ts: Date.now() });
        }
        controller.close();
        return;
      }
      if (value?.byteLength) {
        total += value.byteLength;
        if (total <= MAX_BYTES) chunks.push(value);
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(tapped, { status: res.status, statusText: res.statusText, headers: res.headers });
}
