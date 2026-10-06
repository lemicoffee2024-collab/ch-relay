import type { ProviderId } from "./api.ts";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  short: string;
  kind: "oauth" | "apikey";
  /** Hue used for the provider glyph tile. */
  tint: string;
  blurb: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "chatgpt", name: "ChatGPT", short: "GPT", kind: "oauth", tint: "var(--tint-green)", blurb: "Đăng nhập OAuth, xoay vòng nhiều tài khoản" },
  { id: "antigravity", name: "Antigravity", short: "AG", kind: "oauth", tint: "var(--tint-blue)", blurb: "Google Antigravity qua OAuth" },
  { id: "opencode-zen", name: "OpenCode Zen", short: "Zen", kind: "apikey", tint: "var(--tint-purple)", blurb: "Khoá API OpenCode Zen" },
  { id: "opencode-go", name: "OpenCode Go", short: "Go", kind: "apikey", tint: "var(--tint-orange)", blurb: "Khoá API OpenCode Go" },
];

export const providerInfo = (id: string): ProviderInfo =>
  PROVIDERS.find((p) => p.id === id) ?? { id: id as ProviderId, name: id, short: id.slice(0, 2), kind: "apikey", tint: "var(--tint-gray)", blurb: "" };

const nf = new Intl.NumberFormat("vi-VN");
export const num = (n: number | null | undefined) => nf.format(Math.round(n ?? 0));

export function compact(n: number | null | undefined): string {
  const v = n ?? 0;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(".", ",")} T`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(".", ",")} Tr`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(".", ",")} N`;
  return nf.format(Math.round(v));
}

export function pct(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "–";
  return `${(n * 100).toFixed(digits).replace(".", ",")}%`;
}

export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "–";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1).replace(".", ",")} s`;
}

export function duration(msv: number): string {
  const s = Math.max(0, Math.floor(msv / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} ngày ${h} giờ`;
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút ${sec} giây`;
  return `${sec} giây`;
}

export function countdown(msv: number): string {
  const s = Math.max(0, Math.ceil(msv / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function relTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), "hour");
  return rtf.format(Math.round(diff / 86400_000), "day");
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function contextWindow(n: number): string {
  if (!n) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(".", ",")}M`;
  return `${Math.round(n / 1000)}K`;
}

/** Short "in X" duration for reset times: "25 phút", "2 giờ", "3 ngày". */
export function inShort(msv: number): string {
  const m = Math.max(1, Math.round(msv / 60_000));
  if (m < 60) return `${m} phút`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} giờ`;
  return `${Math.round(h / 24)} ngày`;
}
