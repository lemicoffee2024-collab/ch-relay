// Client-side shaping of the statistics payloads: local-time buckets, heatmap, deltas.
// The server sends UTC hour points; the operator's own calendar decides where days start.

import type { HourPoint } from "./api.ts";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export type BucketKind = "hour" | "6h" | "day";

/** Coarser buckets for longer windows so a chart never has hundreds of points. */
export function pickBucket(spanMs: number): BucketKind {
  if (spanMs <= 3 * DAY + HOUR) return "hour";
  if (spanMs <= 10 * DAY) return "6h";
  return "day";
}

/** Start of the local-time bucket containing `t`. */
export function bucketStart(t: number, kind: BucketKind): number {
  const d = new Date(t);
  if (kind === "hour") d.setMinutes(0, 0, 0);
  else if (kind === "6h") d.setHours(Math.floor(d.getHours() / 6) * 6, 0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const STEP: Record<BucketKind, number> = { hour: HOUR, "6h": 6 * HOUR, day: DAY };

/** Next bucket start, safe across DST changes. */
function nextStart(t: number, kind: BucketKind): number {
  return bucketStart(t + STEP[kind] * 1.5, kind);
}

export interface Series {
  kind: BucketKind;
  times: number[];
  requests: number[];
  errors: number[];
  input: number[];
  output: number[];
}

/** Sum the server's hourly points into local buckets, filling gaps with zeros. */
export function rebucket(hourly: HourPoint[], since: number, until: number, kind = pickBucket(until - since)): Series {
  const times: number[] = [];
  for (let t = bucketStart(since, kind); t <= until; t = nextStart(t, kind)) times.push(t);
  const idx = new Map(times.map((t, i) => [t, i]));
  const out: Series = { kind, times, requests: times.map(() => 0), errors: times.map(() => 0), input: times.map(() => 0), output: times.map(() => 0) };
  for (const h of hourly) {
    const i = idx.get(bucketStart(h.t, kind));
    if (i === undefined) continue;
    out.requests[i]! += h.requests;
    out.errors[i]! += h.errors;
    out.input[i]! += h.input;
    out.output[i]! += h.output;
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Label for a bucket start: hours inside one day, day and hour across days, plain dates for day buckets. */
export function bucketLabel(t: number, kind: BucketKind, multiDay: boolean): string {
  const d = new Date(t);
  const date = `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
  if (kind === "day") return date;
  const hm = `${two(d.getHours())}:00`;
  return multiDay ? `${date} ${hm}` : hm;
}

/** Requests by local weekday (Mon = 0) and hour, from hourly points. */
export function heatmap(hourly: HourPoint[]): { grid: number[][]; max: number; total: number } {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let max = 0;
  let total = 0;
  for (const h of hourly) {
    const d = new Date(h.t);
    const row = grid[(d.getDay() + 6) % 7]!;
    row[d.getHours()]! += h.requests;
    max = Math.max(max, row[d.getHours()]!);
    total += h.requests;
  }
  return { grid, max, total };
}

export type Tone = "good" | "bad" | "neutral";

export interface DeltaInfo {
  pct: number;
  tone: Tone;
}

/**
 * Relative change against the previous period. `worse` says which direction is bad
 * ("up" for errors and latency), so the colour never lies. Null when there is nothing to compare.
 */
export function delta(cur: number | null | undefined, prev: number | null | undefined, worse: "up" | "down" | "none" = "none"): DeltaInfo | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  const pct = (cur - prev) / prev;
  if (Math.abs(pct) < 0.005) return { pct: 0, tone: "neutral" };
  if (worse === "none") return { pct, tone: "neutral" };
  const bad = worse === "up" ? pct > 0 : pct < 0;
  return { pct, tone: bad ? "bad" : "good" };
}

/** Days covered by a window (for "active days" ratios). */
export const spanDays = (r: { since: number; until: number }) => Math.max(1, Math.round((r.until - r.since) / DAY));

/** Plain-text CSV cell. */
export const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Text starting with =,+,-,@ would run as a formula in a spreadsheet (error messages are attacker-influenced): keep it text.
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function downloadCsv(name: string, header: string[], rows: unknown[][]): void {
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
