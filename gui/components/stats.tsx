// Small building blocks shared by the statistics pages.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ErrorKind, RangeSel, UserTag } from "../lib/api.ts";
import { ERROR_KIND_ORDER } from "../../src/lib/error-kind.ts";
import { compact, inShort, num, pct } from "../lib/format.ts";
import { Button, Pill, Segmented } from "./ui.tsx";
import type { DeltaInfo } from "../lib/stats.ts";
import type { QuotaBar, Forecast } from "../lib/quota.ts";

// ---------------------------------------------------------------- labels

export const KIND_INFO: Record<Exclude<ErrorKind, "ok">, { label: string; hint: string }> = {
  overload: { label: "Quá tải", hint: "Máy chủ OpenAI báo quá tải, thường tự hết khi thử lại" },
  rate: { label: "Quá nhanh", hint: "Bị giới hạn tốc độ (429)" },
  network: { label: "Đứt kết nối", hint: "Luồng bị ngắt giữa chừng hoặc không kết nối được" },
  model: { label: "Sai model", hint: "Model không được hỗ trợ hoặc upstream trả model khác" },
  auth: { label: "Xác thực", hint: "Token hết hạn hoặc bị từ chối (401/403)" },
  cancel: { label: "Huỷ", hint: "Phía Codex chủ động huỷ yêu cầu" },
  other: { label: "Lỗi khác", hint: "Không thuộc nhóm nào ở trên" },
};

export const kindLabel = (k: ErrorKind) => (k === "ok" ? "Thành công" : KIND_INFO[k].label);

export const TAG_INFO: Record<UserTag, { label: string; tone: "green" | "red" | "orange" | "gray" | "blue"; hint: string }> = {
  heavy: { label: "Dùng nặng", tone: "orange", hint: "Chiếm phần lớn token của mọi người dùng" },
  steady: { label: "Hoạt động đều", tone: "green", hint: "Có hoạt động trong hầu hết các ngày của kỳ" },
  idle: { label: "Không hoạt động", tone: "gray", hint: "Không có yêu cầu nào trong kỳ này" },
  dormant: { label: "Ngủ đông", tone: "gray", hint: "Đã thêm từ lâu nhưng không dùng trong kỳ này" },
  never: { label: "Chưa từng kết nối", tone: "orange", hint: "Chưa có yêu cầu nào tới máy chủ" },
  errors: { label: "Nhiều lỗi", tone: "red", hint: "Từ 10% yêu cầu trở lên bị lỗi" },
  limited: { label: "Chạm giới hạn", tone: "orange", hint: "Từng vượt 8 luồng đồng thời hoặc 60 yêu cầu/phút" },
  expiring: { label: "Sắp hết hạn", tone: "orange", hint: "Tự xoá trong vòng 3 ngày" },
  multi: { label: "Nhiều thiết bị", tone: "blue", hint: "Một email xuất hiện trên nhiều máy hoặc mạng" },
  new: { label: "Mới", tone: "blue", hint: "Thêm trong 2 ngày qua" },
  denied: { label: "Bị từ chối", tone: "red", hint: "Đã có lần bị chặn vì không nằm trong danh sách cho phép" },
};

export function TagPills({ tags, max = 4 }: { tags: UserTag[]; max?: number }) {
  if (tags.length === 0) return null;
  return (
    <span className="tag-row">
      {tags.slice(0, max).map((t) => (
        <Pill key={t} tone={TAG_INFO[t].tone} title={TAG_INFO[t].hint}>
          {TAG_INFO[t].label}
        </Pill>
      ))}
      {tags.length > max && <span className="dim small">+{tags.length - max}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- range picker

const MAX_SPAN = 90 * 86400_000;
const localInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export function RangePicker({ value, onChange }: { value: RangeSel; onChange: (r: RangeSel) => void }) {
  const [open, setOpen] = useState(value.key === "custom");
  const now = Date.now();
  const [from, setFrom] = useState(localInput(value.key === "custom" ? value.from : now - 86400_000));
  const [to, setTo] = useState(localInput(value.key === "custom" ? value.to : now));
  const [err, setErr] = useState<string | null>(null);

  const apply = () => {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    if (!Number.isFinite(f) || !Number.isFinite(t)) return setErr("Thời gian không hợp lệ");
    if (t <= f) return setErr("Điểm kết thúc phải sau điểm bắt đầu");
    if (t - f > MAX_SPAN) return setErr("Tối đa 90 ngày");
    setErr(null);
    onChange({ key: "custom", from: f, to: t });
  };

  return (
    <div className="range-picker">
      <Segmented<"24h" | "7d" | "30d" | "custom">
        label="Khoảng thời gian"
        value={value.key}
        onChange={(k) => {
          if (k === "custom") setOpen(true);
          else {
            setOpen(false);
            onChange({ key: k });
          }
        }}
        options={[
          { value: "24h", label: "24 giờ" },
          { value: "7d", label: "7 ngày" },
          { value: "30d", label: "30 ngày" },
          { value: "custom", label: "Tuỳ chọn" },
        ]}
      />
      {open && (
        <div className="range-custom" role="group" aria-label="Khoảng thời gian tuỳ chọn">
          <label>
            <span>Từ</span>
            <input type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>Đến</span>
            <input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button size="sm" variant="tinted" onClick={apply}>
            Áp dụng
          </Button>
          {err && (
            <span className="range-err" role="alert">
              {err}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- delta chip

export function Delta({ info, unit = "kỳ trước", digits = 0 }: { info: DeltaInfo | null; unit?: string; digits?: number }) {
  if (!info) return <span className="delta delta-none" title="Kỳ trước không có dữ liệu để so sánh">–</span>;
  const arrow = info.pct > 0 ? "▲" : info.pct < 0 ? "▼" : "•";
  const text = info.pct === 0 ? "không đổi" : `${arrow} ${Math.abs(info.pct * 100).toFixed(digits).replace(".", ",")}%`;
  return (
    <span className={`delta delta-${info.tone}`} title={`So với ${unit}`}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- bars

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  valueText: ReactNode;
  /** Shown dimmed after the value. */
  extra?: ReactNode;
  color?: string;
  title?: string;
}

/** Horizontal ranking bars, scaled to the largest value. */
export function BarList({ items, empty }: { items: BarItem[]; empty?: ReactNode }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <>{empty ?? <p className="dim small">Không có dữ liệu</p>}</>;
  return (
    <ul className="rank">
      {items.map((i) => (
        <li key={i.key} title={i.title}>
          <div className="rank-row">
            <span className="rank-name">{i.label}</span>
            <span className="rank-value">
              {i.valueText}
              {i.extra && <span className="rank-dim"> · {i.extra}</span>}
            </span>
          </div>
          <div className="rank-bar">
            <span style={{ width: `${(i.value / max) * 100}%`, background: i.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One bar split into segments, with a legend that repeats every number (colour is never the only cue). */
export function StackBar({ parts, unit = "" }: { parts: Array<{ key: string; label: string; value: number; color: string; title?: string }>; unit?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total === 0) return <p className="dim small">Không có lỗi nào trong kỳ này 🎉</p>;
  return (
    <div className="stack">
      <div className="stack-bar" role="img" aria-label={parts.map((p) => `${p.label} ${num(p.value)}`).join(", ")}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${num(p.value)}`} />
          ))}
      </div>
      <ul className="stack-legend">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <li key={p.key} title={p.title}>
              <i style={{ background: p.color }} />
              <span>{p.label}</span>
              <b>
                {num(p.value)}
                {unit}
              </b>
              <span className="dim">{pct(p.value / total, p.value / total < 0.1 ? 1 : 0)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

export function errorKindParts(kinds: Partial<Record<ErrorKind, number>>) {
  return ERROR_KIND_ORDER.map((k) => ({
    key: k,
    label: KIND_INFO[k as Exclude<ErrorKind, "ok">].label,
    value: kinds[k] ?? 0,
    color: `var(--k-${k})`,
    title: KIND_INFO[k as Exclude<ErrorKind, "ok">].hint,
  }));
}

// ---------------------------------------------------------------- heatmap

const DOW = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const DOW_LONG = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy", "Chủ nhật"];

export function Heat({ grid, max }: { grid: number[][]; max: number }) {
  const peak = useMemo(() => {
    let best = { d: 0, h: 0, v: 0 };
    grid.forEach((row, d) => row.forEach((v, h) => v > best.v && (best = { d, h, v })));
    return best;
  }, [grid]);
  if (max === 0) return <p className="dim small">Chưa có yêu cầu nào trong kỳ này</p>;
  return (
    <div className="heat" role="img" aria-label={`Bản đồ nhiệt theo giờ trong tuần. Cao điểm: ${DOW_LONG[peak.d]} lúc ${peak.h} giờ với ${num(peak.v)} yêu cầu`}>
      <div className="heat-hours" aria-hidden="true">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h}>{h % 3 === 0 ? h : ""}</span>
        ))}
      </div>
      {grid.map((row, d) => (
        <div className="heat-row" key={d} aria-hidden="true">
          <span className="heat-dow">{DOW[d]}</span>
          {row.map((v, h) => (
            <span
              key={h}
              className="heat-cell"
              style={{ ["--v" as string]: v === 0 ? 0 : 0.12 + 0.88 * Math.sqrt(v / max) }}
              title={`${DOW_LONG[d]} ${String(h).padStart(2, "0")}:00 · ${num(v)} yêu cầu`}
            />
          ))}
        </div>
      ))}
      <div className="heat-scale" aria-hidden="true">
        <span>Ít</span>
        <i />
        <span>Nhiều</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- latency ladder

export function Ladder({ rows }: { rows: Array<{ label: string; ms: number | null; color?: string }> }) {
  const max = Math.max(1, ...rows.map((r) => r.ms ?? 0));
  const fmt = (v: number) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1).replace(".", ",")} s`);
  return (
    <ul className="ladder">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="ladder-label">{r.label}</span>
          <span className="ladder-track">
            <span style={{ width: r.ms ? `${Math.max(2, (r.ms / max) * 100)}%` : 0, background: r.color }} />
          </span>
          <b className="tabular">{r.ms == null ? "–" : fmt(r.ms)}</b>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- quota meter

export function Meter({ bar, forecast, now }: { bar: QuotaBar; forecast?: Forecast; now: number }) {
  const tone = bar.used >= 0.9 ? "red" : bar.used >= 0.7 ? "orange" : "green";
  return (
    <div className="qmeter">
      <div className="qmeter-head">
        <span>{bar.label}</span>
        <b className="tabular">{pct(bar.used, bar.used > 0 && bar.used < 0.1 ? 1 : 0)}</b>
      </div>
      <div className="qmeter-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.used * 100)} aria-label={`${bar.label} đã dùng`}>
        <span className={`qmeter-${tone}`} style={{ width: `${Math.max(1.5, bar.used * 100)}%` }} />
      </div>
      <div className="qmeter-foot">
        {bar.resetAt && bar.resetAt > now ? <span className="dim">làm mới sau {inShort(bar.resetAt - now)}</span> : <span className="dim">chưa rõ thời điểm làm mới</span>}
        {forecast?.state === "exhausted" && <Pill tone="red">Đã hết</Pill>}
        {forecast?.state === "will-exhaust" && <Pill tone="orange">Hết sau ~{inShort(forecast.etaMs)}</Pill>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small helpers

/** Debounced copy of `value` (for search boxes). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** `n / total` as a percentage string, safe for total = 0. */
export const share = (n: number, total: number, digits = 0) => (total > 0 ? pct(n / total, digits) : "–");

export const tokens = (v: number) => compact(v);
