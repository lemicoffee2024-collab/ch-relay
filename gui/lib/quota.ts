// Turn an arbitrary provider quota snapshot into a list of display bars.
// ChatGPT stores used percents (shortPercent/weeklyPercent/..ResetAt); Antigravity stores
// remaining fractions per model family. Anything unrecognised is ignored.

export interface QuotaBar {
  key: string;
  label: string;
  /** 0..1 fraction used. */
  used: number;
  /** Epoch ms when the window resets, if known. */
  resetAt: number | null;
  mode: "used" | "remaining";
}

const WORDS: Record<string, string> = {
  short: "5 giờ",
  primary: "5 giờ",
  hourly: "Theo giờ",
  daily: "Theo ngày",
  weekly: "Theo tuần",
  secondary: "Theo tuần",
  tertiary: "Hạn mức 3",
  monthly: "Theo tháng",
};

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e10 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e10 ? n * 1000 : n;
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

function humanize(s: string): string {
  const base = s
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  const lower = base.toLowerCase();
  for (const [w, label] of Object.entries(WORDS)) if (lower === w || lower.startsWith(`${w} `)) return label;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function findReset(obj: Record<string, unknown>, prefix: string): number | null {
  const keys = Object.keys(obj);
  const p = prefix.toLowerCase();
  const cand =
    keys.find((k) => k.toLowerCase().startsWith(p) && /reset/i.test(k)) ??
    (p ? undefined : keys.find((k) => /reset/i.test(k)));
  return cand ? toMs(obj[cand]) : null;
}

const NAME_KEYS = ["label", "displayName", "name", "family", "modelId", "model", "id", "group", "bucket"];

function nameOf(o: Record<string, unknown>): string | null {
  for (const k of NAME_KEYS) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
}

export function quotaBars(q: Record<string, unknown> | null | undefined): QuotaBar[] {
  if (!q || typeof q !== "object") return [];
  const out: QuotaBar[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, ctx: string, depth: number) => {
    if (depth > 4 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        const nm = v && typeof v === "object" && !Array.isArray(v) ? nameOf(v as Record<string, unknown>) : null;
        visit(v, nm ?? (node.length === 1 && ctx ? ctx : `${ctx} ${i + 1}`.trim()), depth + 1);
      });
      return;
    }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === "updatedAt") continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        let used: number | null = null;
        let mode: QuotaBar["mode"] = "used";
        let prefix = "";
        const m1 = k.match(/^(.*?)(?:_?used)?_?percent(?:age)?$/i);
        const m2 = k.match(/^(.*?)_?remaining_?(?:fraction|ratio|percent)?$/i);
        if (m1 && !/remaining/i.test(k)) {
          used = v > 1 || /percent/i.test(k) ? v / 100 : v;
          prefix = m1[1] ?? "";
        } else if (m2 || /fraction/i.test(k)) {
          const frac = /percent/i.test(k) || v > 1 ? v / 100 : v;
          used = 1 - frac;
          mode = "remaining";
          prefix = m2?.[1] ?? "";
        }
        if (used == null) continue;
        const label = prefix ? humanize(prefix) : ctx ? humanize(ctx) : "Hạn mức";
        const key = `${ctx}|${prefix}|${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, label, used: Math.max(0, Math.min(1, used)), resetAt: findReset(o, prefix), mode });
      } else if (v && typeof v === "object") {
        // Arrays inside a named object (groups[].buckets[]) inherit the parent's name.
        const nm = !Array.isArray(v) ? nameOf(v as Record<string, unknown>) : ctx && nameOf(o) ? ctx : null;
        visit(v, nm ?? k, depth + 1);
      }
    }
  };
  visit(q, "", 0);
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// forecast: will this window run out before it resets?
// ---------------------------------------------------------------------------

const H = 3600_000;
const WINDOWS: Array<[RegExp, number]> = [
  [/5 giờ/i, 5 * H],
  [/theo giờ/i, H],
  [/theo ngày/i, 24 * H],
  [/theo tuần/i, 7 * 24 * H],
  [/theo tháng/i, 30 * 24 * H],
];

/** Length of a quota window, read from its label; null when unknown. */
export function windowMs(label: string): number | null {
  return WINDOWS.find(([re]) => re.test(label))?.[1] ?? null;
}

export type Forecast =
  | { state: "exhausted" }
  | { state: "will-exhaust"; etaMs: number }
  | { state: "ok" }
  | { state: "unknown" };

/**
 * Straight-line projection: the share used so far divided by the time elapsed in the window
 * gives the burn rate. Needs a known window, a reset time, and enough elapsed time to mean something.
 */
export function forecast(bar: QuotaBar, now: number): Forecast {
  if (bar.used >= 0.995) return { state: "exhausted" };
  const win = windowMs(bar.label);
  if (!win || !bar.resetAt || bar.resetAt <= now) return { state: "unknown" };
  const elapsed = win - (bar.resetAt - now);
  if (elapsed < Math.max(10 * 60_000, win * 0.08) || elapsed > win) return { state: "unknown" };
  const rate = bar.used / elapsed;
  if (rate <= 0) return { state: "ok" };
  const eta = (1 - bar.used) / rate;
  return now + eta < bar.resetAt ? { state: "will-exhaust", etaMs: eta } : { state: "ok" };
}
