// Statistics worker: its own read-only SQLite connection, so a multi-second scan over
// `usage` never blocks the event loop that is streaming LLM responses.
// Compiled builds must list this file as an extra entrypoint (see docs/stats.md).

import { Database } from "bun:sqlite";
import { runJob, type JobName } from "./queries.ts";

declare var self: Worker;

let db: Database | null = null;

type Msg = { id: number; kind: "open"; path: string } | { id: number; kind: "job"; name: JobName; params: unknown };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.kind === "open") {
      db = new Database(m.path, { readonly: true });
      db.exec("PRAGMA busy_timeout = 5000");
      self.postMessage({ id: m.id, ok: true });
      return;
    }
    if (!db) throw new Error("stats worker not opened");
    self.postMessage({ id: m.id, ok: true, result: runJob(db, m.name, m.params as never) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
