import { useEffect, useMemo, useRef, useState } from "react";
import { compact, num } from "../lib/format.ts";

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/** Monotone cubic (Fritsch–Carlson) path: smooth but never overshoots below zero. */
function monotonePath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = m[i - 1]!;
    const b = m[i]!;
    t.push(a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b));
  }
  t.push(m[n - 2]!);
  let d = `M${pts[0]![0].toFixed(2)},${pts[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${(x0 + h).toFixed(2)},${(y0 + t[i]! * h).toFixed(2)} ${(x1 - h).toFixed(2)},${(y1 - t[i + 1]! * h).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

/** Max for a 4-step axis whose step is a round number (integer, at least 1). */
function niceMax(v: number): number {
  if (v <= 0) return 4;
  const raw = v / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((c) => f <= c + 1e-9) ?? 10;
  let step = nice * exp;
  if (step < 1) step = 1;
  else if (!Number.isInteger(step) && step < 10) step = Math.ceil(step);
  return step * 4;
}

export function TimelineChart({
  times,
  series,
  formatTime,
  height = 220,
  ariaLabel,
  format,
}: {
  times: number[];
  series: Series[];
  formatTime: (t: number) => string;
  height?: number;
  ariaLabel: string;
  /** Value formatter for the axis and tooltip (default: compact numbers). */
  format?: (v: number) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const pad = { l: 44, r: 12, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values))), [series]);
  const n = times.length;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 96))));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
  };

  const tipLeft = hover != null ? x(hover) : 0;

  return (
    <div className="chart" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        width={W}
        height={H}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={i === 0 ? "chart-axis" : "chart-grid"} vectorEffect="non-scaling-stroke" />
            <text x={pad.l - 10} y={y(v) + 4} textAnchor="end" className="chart-tick">
              {(format ?? compact)(v)}
            </text>
          </g>
        ))}
        {times.map((t, i) => {
          const show = i % labelEvery === 0 && (n - 1 - i >= labelEvery * 0.6 || i === n - 1 || i === 0);
          if (!show && !(i === n - 1 && n > 1)) return null;
          return (
            <text key={t} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="chart-tick">
              {formatTime(t)}
            </text>
          );
        })}
        {series.map((s) => {
          const pts = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
          const line = monotonePath(pts);
          const area = pts.length ? `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z` : "";
          return (
            <g key={s.key}>
              <path d={area} fill={`url(#fill-${s.key})`} className="chart-area" />
              <path d={line} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="chart-line" />
            </g>
          );
        })}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="chart-cursor" vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {hover != null &&
        series.map((s) => (
          <span
            key={s.key}
            className="chart-dot"
            style={{ left: tipLeft, top: y(s.values[hover] ?? 0), background: s.color }}
            aria-hidden="true"
          />
        ))}
      {hover != null && (
        <div className={`chart-tip ${tipLeft > W * 0.7 ? "flip" : ""}`} style={{ left: tipLeft }} role="status">
          <div className="chart-tip-time">{formatTime(times[hover]!)}</div>
          {series.map((s) => (
            <div key={s.key} className="chart-tip-row">
              <span className="dot" style={{ background: s.color }} />
              <span>{s.label}</span>
              <b>{format ? format(s.values[hover] ?? 0) : num(s.values[hover])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline for KPI tiles. */
export function Sparkline({ values, color = "var(--accent)" }: { values: number[]; color?: string }) {
  const W = 120;
  const H = 32;
  if (values.length < 2) return <svg width={W} height={H} aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - (v / max) * (H - 6)] as [number, number]);
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={monotonePath(pts)} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  );
}
