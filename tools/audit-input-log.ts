import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** bun tools/audit-input-log.ts <service.log|agent.log> [--per-request]
 * Read-only, offline. Old logs cannot yield token savings without denominators. */
const [path, flag] = process.argv.slice(2);
if (!path) throw new Error("Usage: bun tools/audit-input-log.ts <log-path> [--per-request]");
const requests = new Map<string, Record<string, any>>();
const legacy = { inputtrim_events: 0, trimmed_items: 0, metatrim_events: 0, stripped_fields: 0 };
for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
  let match = line.match(/inputtrim items=(\d+)/);
  if (match) { legacy.inputtrim_events++; legacy.trimmed_items += Number(match[1]); }
  match = line.match(/metatrim fields=(\d+)/);
  if (match) { legacy.metatrim_events++; legacy.stripped_fields += Number(match[1]); }
  const start = line.indexOf("inputaudit {");
  if (start < 0) continue;
  let event: any;
  try { event = JSON.parse(line.slice(start + "inputaudit ".length)); } catch { continue; }
  if (typeof event.id !== "string" || typeof event.stage !== "string") continue;
  const record = requests.get(event.id) ?? { id: event.id, lane: event.lane, model: event.model, attempts: 0 };
  requests.set(event.id, record);
  if (event.stage === "upstream_attempt") {
    record.attempts++;
    record.attempt_json_bytes = (record.attempt_json_bytes ?? 0) + event.json_bytes;
    record.attempt_visible_chars = (record.attempt_visible_chars ?? 0) + event.visible_chars;
    if (!record.forward) record.forward = event;
  } else record[event.stage] = event;
}
const pct = (part: number, all: number) => all ? Math.round(part / all * 10000) / 100 : null;
const rows = [...requests.values()].map(r => ({
  id: r.id, lane: r.lane, model: r.model, upstream_attempts: r.attempts,
  upstream_attempt_json_bytes: r.attempt_json_bytes ?? 0,
  upstream_attempt_visible_chars: r.attempt_visible_chars ?? 0,
  completed: !!r.done,
  trim_visible_chars_removed: r.inputtrim?.visible_chars_removed ?? null,
  trim_visible_chars_removed_pct: r.inputtrim?.visible_chars_removed_pct ?? null,
  meta_json_bytes_removed: r.metatrim?.json_bytes_removed ?? null,
  meta_visible_chars_removed: r.metatrim?.visible_chars_removed ?? null,
  injected_visible_chars_added: r.injected ? -r.injected.visible_chars_removed : null,
  first_attempt_net_visible_chars_removed_pct: r.before && r.forward
    ? pct(r.before.visible_chars - r.forward.visible_chars, r.before.visible_chars) : null,
  repeated_schema_chars: r.forward?.repeated_schema_chars ?? null,
  reasoning_json_bytes: r.forward?.reasoning_json_bytes ?? null,
  prompt_cache_key_present: r.forward?.prompt_cache_key_present ?? null,
  reported_input_tokens: r.done?.input_tokens ?? null,
  reported_cached_tokens: r.done?.cached_tokens ?? null,
  input_token_savings_pct: null,
}));
const known = rows.filter(r => r.reported_input_tokens !== null);
const cacheKnown = known.filter(r => r.reported_cached_tokens !== null);
const sum = (rs: typeof rows, key: keyof typeof rows[number]) => rs.reduce((n, r) => n + (Number(r[key]) || 0), 0);
const distribution = (key: keyof typeof rows[number]) => {
  const a = rows.filter(r => typeof r[key] === "number").map(r => Number(r[key])).sort((a, b) => a - b);
  return { n: a.length, p50: a[Math.floor(a.length * .5)] ?? null, p95: a[Math.floor(a.length * .95)] ?? null };
};
console.log(JSON.stringify({
  legacy,
  warning: "Bytes and UTF-16 character counts are NOT tokens. Old logs lack before/after denominators. Reported usage may omit retries or prior continuation segments; these are not task-wide token totals.",
  requests: rows.length, done: rows.filter(r => r.completed).length,
  upstream_attempts: sum(rows, "upstream_attempts"),
  upstream_attempt_json_bytes: sum(rows, "upstream_attempt_json_bytes"),
  upstream_attempt_visible_chars: sum(rows, "upstream_attempt_visible_chars"),
  requests_with_multiple_attempts: rows.filter(r => r.upstream_attempts > 1).length,
  reported_usage_requests: known.length, reported_usage_coverage_pct: pct(known.length, rows.filter(r => r.completed).length),
  reported_input_tokens: known.length ? sum(known, "reported_input_tokens") : null,
  reported_cached_tokens: cacheKnown.length ? sum(cacheKnown, "reported_cached_tokens") : null,
  cached_share_of_input_where_both_reported_pct: pct(sum(cacheKnown, "reported_cached_tokens"), sum(cacheKnown, "reported_input_tokens")),
  trim_visible_chars_removed_pct: distribution("trim_visible_chars_removed_pct"),
  first_attempt_net_visible_chars_removed_pct: distribution("first_attempt_net_visible_chars_removed_pct"),
  injected_visible_chars_added: distribution("injected_visible_chars_added"),
  meta_json_bytes_removed: distribution("meta_json_bytes_removed"),
  meta_visible_chars_removed: distribution("meta_visible_chars_removed"),
  input_token_savings_pct: null,
  ...(flag === "--per-request" ? { per_request: rows } : {}),
}, null, 2));

