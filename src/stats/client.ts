// Runs statistics jobs off the main thread (worker.ts) behind a small in-memory cache.
//
// - single-flight: concurrent identical requests share one computation;
// - TTL cache, bounded, in memory only (a GET never writes anything);
// - falls back to running inline when there is no worker: in-memory test DBs, or a build
//   that forgot to bundle worker.ts (logged once; correct but blocks while it runs).

import { dbFilePath, getDb } from "../store/db.ts";
import { log } from "../lib/log.ts";
import { runJob, type JobName, type JobParams, type JobResult } from "./queries.ts";
import { clearParts } from "./parts.ts";

const MAX_ENTRIES = 96;
const JOB_TIMEOUT_MS = 120_000;

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function failAll(err: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
    pending.delete(id);
  }
}

function send(msg: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("stats job timed out"));
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, ...msg });
  });
}

/**
 * Where worker.ts lives relative to this module. From source it sits beside client.ts; in a
 * `bun build --compile src/cli.ts src/stats/worker.ts` binary, paths resolve from the bundle
 * root (src/), so it is `./stats/worker.ts`. Try both rather than sniff the runtime.
 */
const WORKER_PATHS = ["./worker.ts", "./stats/worker.ts", "./stats/worker.js", "./worker.js"];

function handleMessage(e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>): void {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  clearTimeout(p.timer);
  if (e.data.ok) p.resolve(e.data.result);
  else p.reject(new Error(e.data.error ?? "stats job failed"));
}

/** Start one worker candidate and wait until it has opened the database. */
function tryWorker(url: string, path: string): Promise<void> {
  const w = new Worker(url);
  worker = w;
  let opened = false;
  w.onmessage = handleMessage;
  w.onerror = (e: ErrorEvent) => {
    if (!opened) {
      // Module not found / failed to load: reject the pending open so the caller can try the next path.
      w.terminate();
      if (worker === w) worker = null;
      failAll(new Error(e.message ?? "stats worker failed to start"));
      return;
    }
    log.warn("stats worker error", e.message ?? String(e));
    broken = true;
    worker = null;
    ready = null;
    failAll(new Error("stats worker died"));
  };
  (w as unknown as { unref?: () => void }).unref?.();
  return send({ kind: "open", path }).then(() => {
    opened = true;
  });
}

async function startWorker(path: string): Promise<void> {
  let last: unknown;
  for (const rel of WORKER_PATHS) {
    try {
      await tryWorker(new URL(rel, import.meta.url).href, path);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

let warnedInline = false;
/** Tests: point the worker at a file (VACUUM INTO of the in-memory DB) to exercise the real thread path. */
let pathOverride: string | null | undefined;
export function setStatsPathForTests(path: string | null | undefined): void {
  pathOverride = path;
}
const statsPath = () => (pathOverride !== undefined ? pathOverride : dbFilePath());

async function execute<K extends JobName>(name: K, params: JobParams<K>): Promise<Awaited<JobResult<K>>> {
  const path = statsPath();
  if (path && !broken) {
    let up = false;
    try {
      ready ??= startWorker(path);
      await ready;
      up = true;
    } catch (err) {
      // The worker never came up (missing entrypoint, open failed): run inline from now on.
      broken = true;
      worker?.terminate();
      worker = null;
      ready = null;
      log.warn("stats worker unavailable, running statistics inline", err instanceof Error ? err.message : String(err));
    }
    // A job that fails or times out is reported, never silently re-run on the main thread.
    if (up) return (await send({ kind: "job", name, params })) as Awaited<JobResult<K>>;
  }
  if (path && !warnedInline) {
    warnedInline = true;
    log.warn("statistics are running on the main thread (rebuild with src/stats/worker.ts as an entrypoint)");
  }
  return runJob(getDb(), name, params) as Awaited<JobResult<K>>;
}

/** Run `name` with `params`, cached for `ttlMs`. Callers should quantize time params so keys repeat. */
export async function stat<K extends JobName>(name: K, params: JobParams<K>, ttlMs: number): Promise<Awaited<JobResult<K>>> {
  const key = `${name}:${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Awaited<JobResult<K>>;
  const running = inflight.get(key);
  if (running) return running as Promise<Awaited<JobResult<K>>>;
  const p = execute(name, params)
    .then((value) => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Build the worker's hour cache for the last week in the background right after boot, so the
 * first dashboard visit is a merge of cached hours rather than a multi-second scan.
 */
export function warmStats(): void {
  if (!dbFilePath()) return;
  const until = Math.ceil(Date.now() / 3600_000) * 3600_000;
  void stat("overview", { since: until - 7 * 86400_000, until }, 0).catch((err) => log.warn("stats warm-up failed", err instanceof Error ? err.message : String(err)));
}

/** For tests. */
export function resetStats(): void {
  cache.clear();
  inflight.clear();
  worker?.terminate();
  worker = null;
  ready = null;
  broken = false;
  clearParts(getDb());
  warnedInline = false;
  failAll(new Error("stats reset"));
}
