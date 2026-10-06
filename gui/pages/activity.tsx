import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ErrorKind, type RequestFilter, type RequestRow } from "../lib/api.ts";
import { useHashParams, usePoll } from "../lib/hooks.ts";
import { clock, compact, dateTime, ms, num, pct } from "../lib/format.ts";
import { Button, Card, Empty, ErrorBanner, PageHeader, Pill, ProviderGlyph, Sheet, Skeleton, Toggle, useToast } from "../components/ui.tsx";
import { IconCopy, IconDownload, IconList, IconSearch } from "../components/icons.tsx";
import { KIND_INFO, kindLabel, useDebounced } from "../components/stats.tsx";
import { downloadCsv } from "../lib/stats.ts";
import { SOFT_KINDS } from "../../src/lib/error-kind.ts";

const PAGE = 100;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra", "none"];
const MIN_MS = [
  { v: "", label: "Mọi độ trễ" },
  { v: "5000", label: "Chậm hơn 5 giây" },
  { v: "15000", label: "Chậm hơn 15 giây" },
  { v: "30000", label: "Chậm hơn 30 giây" },
  { v: "60000", label: "Chậm hơn 1 phút" },
  { v: "120000", label: "Chậm hơn 2 phút" },
];

function tone(kind: ErrorKind): "green" | "orange" | "red" {
  if (kind === "ok") return "green";
  return SOFT_KINDS.has(kind) ? "orange" : "red";
}

const label = (r: RequestRow) => (r.kind === "ok" ? String(r.status) : kindLabel(r.kind).toLowerCase());

/** Per-model 95th percentile of the OK rows loaded so far: a row above it is "slow for this model". */
function slowLimits(rows: RequestRow[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of rows) if (r.kind === "ok") (by.get(r.requestedModel) ?? by.set(r.requestedModel, []).get(r.requestedModel)!).push(r.durationMs);
  const out = new Map<string, number>();
  for (const [m, v] of by) {
    if (v.length < 20) continue;
    v.sort((a, b) => a - b);
    out.set(m, Math.max(10_000, v[Math.floor(v.length * 0.95)]!));
  }
  return out;
}

function RequestsTable({ rows, onOpen, selected, slow }: { rows: RequestRow[]; onOpen: (r: RequestRow) => void; selected: number | null; slow: Map<string, number> }) {
  const today = new Date().toDateString();
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Thời gian</th>
          <th scope="col">Model</th>
          <th scope="col">Tài khoản</th>
          <th scope="col">Trạng thái</th>
          <th scope="col" className="num">
            Độ trễ
          </th>
          <th scope="col" className="num">
            Token vào → ra
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isSlow = r.kind === "ok" && r.durationMs > (slow.get(r.requestedModel) ?? Infinity);
          return (
            <tr
              key={r.id}
              className={`clickable ${selected === r.id ? "selected" : ""}`}
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => e.key === "Enter" && onOpen(r)}
              title={r.error ?? undefined}
              aria-label={`Xem chi tiết yêu cầu ${r.requestedModel} lúc ${clock(r.ts)}`}
            >
              <td className="tabular dim cell-time">{new Date(r.ts).toDateString() === today ? clock(r.ts) : dateTime(r.ts)}</td>
              <td>
                <span className="cell-model">
                  <ProviderGlyph id={r.provider} size={18} />
                  <span className="mono ellipsis" title={r.model && r.model !== r.requestedModel ? `${r.requestedModel} → ${r.model}` : r.requestedModel}>
                    {r.model || r.requestedModel}
                  </span>
                  {r.model && r.model !== r.requestedModel && <span className="dim small">← {r.requestedModel}</span>}
                  {r.effort && <span className="chip">{r.effort}</span>}
                </span>
              </td>
              <td className="ellipsis cell-acct">{r.accountLabel ?? <span className="dim">–</span>}</td>
              <td>
                <Pill tone={tone(r.kind)} title={r.error ?? undefined}>
                  {label(r)}
                </Pill>
              </td>
              <td className={`num tabular ${isSlow ? "slow" : ""}`} title={isSlow ? "Chậm hơn 95% các yêu cầu cùng model đã tải" : undefined}>
                {ms(r.durationMs)}
                {r.firstTokenMs ? <div className="dim small">đầu {ms(r.firstTokenMs)}</div> : null}
              </td>
              <td className="num tabular">
                {compact(r.input)} <span className="dim">→</span> {compact(r.output)}
                {r.cached > 0 && <div className="dim small">cache {compact(r.cached)}</div>}
                {r.reasoning > 0 && <div className="dim small">suy luận {compact(r.reasoning)}</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Summary({ rows }: { rows: RequestRow[] }) {
  const s = useMemo(() => {
    const ok = rows.filter((r) => r.kind === "ok").map((r) => r.durationMs).sort((a, b) => a - b);
    const input = rows.reduce((a, r) => a + r.input, 0);
    return {
      n: rows.length,
      errors: rows.length - ok.length,
      avg: rows.length ? rows.reduce((a, r) => a + r.durationMs, 0) / rows.length : 0,
      p95: ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.95))]! : null,
      input,
      output: rows.reduce((a, r) => a + r.output, 0),
      cache: input ? rows.reduce((a, r) => a + r.cached, 0) / input : 0,
    };
  }, [rows]);
  if (s.n === 0) return null;
  return (
    <div className="summary-strip" role="status" aria-label="Tóm tắt các dòng đã tải">
      <span>
        <b>{num(s.n)}</b> dòng đã tải
      </span>
      <span className={s.errors ? "bad" : ""}>
        <b>{num(s.errors)}</b> lỗi ({pct(s.errors / s.n, 1)})
      </span>
      <span>
        độ trễ TB <b>{ms(s.avg)}</b>
      </span>
      <span>
        p95 <b>{ms(s.p95)}</b>
      </span>
      <span>
        token <b>{compact(s.input)}</b> → <b>{compact(s.output)}</b>
      </span>
      <span>
        cache <b>{pct(s.cache)}</b>
      </span>
    </div>
  );
}

export function ActivityPage() {
  const [live, setLive] = useState(true);
  const [params, setParams] = useHashParams();
  const toast = useToast();

  // Filters live in the URL so a link from another page (or a bookmark) reproduces the view.
  const status = params.get("status") === "err" ? "err" : params.get("status") === "ok" ? "ok" : undefined;
  const account = params.get("account") ?? undefined;
  const model = params.get("model") ?? undefined;
  const effort = params.get("effort") ?? undefined;
  const minMs = params.get("minMs") ?? "";
  const qParam = params.get("q") ?? "";

  const [text, setText] = useState(qParam);
  const q = useDebounced(text.trim(), 350);
  useEffect(() => {
    if (q !== qParam) setParams({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filter: RequestFilter = useMemo(
    () => ({ status, account, model, effort, minMs: minMs ? Number(minMs) : undefined, q: qParam || undefined }),
    [status, account, model, effort, minMs, qParam],
  );
  const filterKey = JSON.stringify(filter);
  const active = Object.values(filter).some((v) => v !== undefined);

  // Tag every result with the filter it answers: while a new filter loads, usePoll still holds the old data.
  const head = usePoll(async () => ({ key: filterKey, rows: await api.requests({ ...filter, limit: PAGE }) }), live ? 5000 : 0, `${filterKey}|${live}`);
  // Every row ever loaded for this filter, by id. The polled head slides forward as new requests
  // arrive, so pages already loaded must never be dropped (that would leave a gap in the list).
  const [store, setStore] = useState<{ key: string; rows: Map<number, RequestRow> }>({ key: filterKey, rows: new Map() });
  const [more, setMore] = useState<"idle" | "loading" | "done">("idle");
  const [pulse, setPulse] = useState(0);
  useEffect(() => setPulse((p) => p + 1), [head.data]);
  useEffect(() => setMore("idle"), [filterKey]);

  const addRows = useCallback((key: string, page: RequestRow[]) => {
    setStore((s) => {
      const rows = s.key === key ? new Map(s.rows) : new Map<number, RequestRow>();
      for (const r of page) rows.set(r.id, r);
      return { key, rows };
    });
  }, []);
  useEffect(() => {
    if (head.data && head.data.key === filterKey) addRows(filterKey, head.data.rows);
  }, [head.data, filterKey, addRows]);

  const rows = useMemo(() => (store.key === filterKey ? [...store.rows.values()].sort((a, b) => b.id - a.id) : []), [store, filterKey]);

  const loadMore = useCallback(async () => {
    if (more !== "idle" || rows.length === 0) return;
    setMore("loading");
    try {
      const page = await api.requests({ ...filter, limit: PAGE, before: rows[rows.length - 1]!.id });
      addRows(filterKey, page);
      setMore(page.length < PAGE ? "done" : "idle");
    } catch (e) {
      setMore("idle");
      toast("error", "Không tải thêm được", e instanceof Error ? e.message : String(e));
    }
  }, [more, rows, filter, filterKey, addRows, toast]);

  // Auto-load the next page when the end of the list scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && void loadMore(), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const [open, setOpen] = useState<RequestRow | null>(null);
  const slow = useMemo(() => slowLimits(rows), [rows]);

  // Suggestions for the model box: what the dashboard already knows.
  const models = usePoll(() => api.usage({ key: "24h" }), 0);
  const modelNames = (models.data?.byModel ?? []).map((m) => m.model);
  const efforts = useMemo(() => [...new Set([...EFFORTS, ...rows.map((r) => r.effort).filter((e): e is string => !!e)])], [rows]);

  const set = (patch: Record<string, string | undefined>) => setParams(patch);
  const clear = () => {
    setText("");
    setParams({ status: undefined, account: undefined, model: undefined, effort: undefined, minMs: undefined, q: undefined });
  };

  const exportCsv = () =>
    downloadCsv(
      `nhat-ky-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Thời gian", "Nhà cung cấp", "Model", "Model phục vụ", "Effort", "Tài khoản", "Trạng thái", "Loại", "Độ trễ (ms)", "Token đầu (ms)", "Token vào", "Cache", "Token ra", "Suy luận", "Lỗi"],
      rows.map((r) => [new Date(r.ts).toISOString(), r.provider, r.requestedModel, r.model, r.effort, r.accountLabel, r.status, r.kind, r.durationMs, r.firstTokenMs, r.input, r.cached, r.output, r.reasoning, r.error]),
    );

  return (
    <div className="page wide">
      <PageHeader title="Nhật ký" subtitle="Các yêu cầu Codex gần đây, có bộ lọc và tải thêm.">
        <Button size="sm" variant="secondary" icon={<IconDownload size={14} />} onClick={exportCsv} disabled={rows.length === 0}>
          Xuất CSV
        </Button>
        <label className="live">
          <span className={`live-dot ${live ? "on" : ""}`} key={pulse} aria-hidden="true" />
          <span>Tự làm mới</span>
          <Toggle checked={live} onChange={setLive} label="Tự làm mới mỗi 5 giây" />
        </label>
      </PageHeader>

      <div className="filters" role="search" aria-label="Bộ lọc nhật ký">
        <div className="filters-row">
          <div className="pillset" role="group" aria-label="Trạng thái">
            {([[undefined, "Tất cả"], ["ok", "Thành công"], ["err", "Lỗi"]] as const).map(([v, l]) => (
              <button key={l} className={`chip-btn ${status === v ? "on" : ""}`} aria-pressed={status === v} onClick={() => set({ status: v })}>
                {l}
              </button>
            ))}
          </div>
          <label className="select">
            <span className="sr-only">Effort</span>
            <select value={effort ?? ""} onChange={(e) => set({ effort: e.target.value || undefined })} aria-label="Effort">
              <option value="">Mọi effort</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e === "none" ? "Mặc định (không có)" : e}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            <span className="sr-only">Độ trễ tối thiểu</span>
            <select value={minMs} onChange={(e) => set({ minMs: e.target.value || undefined })} aria-label="Độ trễ tối thiểu">
              {MIN_MS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="filters-row">
          <label className="search grow">
            <IconSearch size={15} />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tìm trong nội dung lỗi (ví dụ: overloaded, socket)" aria-label="Tìm trong lỗi" />
          </label>
          <label className="search">
            <span className="sr-only">Model</span>
            <input list="model-names" value={model ?? ""} onChange={(e) => set({ model: e.target.value.trim() || undefined })} placeholder="Model" aria-label="Lọc theo model" />
            <datalist id="model-names">
              {modelNames.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {account && (
            <span className="filter-chip" title={account}>
              {`Tài khoản: ${account}`}
              <button onClick={() => set({ account: undefined })} aria-label="Bỏ lọc tài khoản">
                ×
              </button>
            </span>
          )}
          {active && (
            <button className="link-btn" onClick={clear}>
              Xoá bộ lọc
            </button>
          )}
        </div>
      </div>

      {head.error && <ErrorBanner message={`Không tải được dữ liệu: ${head.error}`} onRetry={head.reload} />}

      <Summary rows={rows} />

      <Card className="flush">
        {head.loading && rows.length === 0 ? (
          <div className="pad">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ padding: "8px 0" }}>
                <Skeleton h={22} />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={<IconList size={28} />} title={active ? "Không có yêu cầu nào khớp bộ lọc" : "Chưa có yêu cầu nào"}>
            {active ? "Thử nới lỏng bộ lọc hoặc bỏ tìm kiếm." : "Hãy đồng bộ model xuống Codex rồi dùng Codex như bình thường. Mỗi yêu cầu sẽ hiện ở đây."}
          </Empty>
        ) : (
          <div className="table-wrap" tabIndex={0} aria-label="Bảng yêu cầu gần đây">
            <RequestsTable rows={rows} onOpen={setOpen} selected={open?.id ?? null} slow={slow} />
            <div ref={sentinel} className="table-more">
              {more === "done" ? (
                <span className="dim small">Đã hiện hết các yêu cầu khớp bộ lọc</span>
              ) : (
                <Button size="sm" variant="tinted" busy={more === "loading"} onClick={() => void loadMore()}>
                  Tải thêm
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      <RequestDrawer row={open} onClose={() => setOpen(null)} onFilter={(patch) => (set(patch), setOpen(null))} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// one request
// ---------------------------------------------------------------------------

function RequestDrawer({ row: r, onClose, onFilter }: { row: RequestRow | null; onClose: () => void; onFilter: (patch: Record<string, string>) => void }) {
  // Keep the last row while the sheet animates out.
  const last = useRef<RequestRow | null>(null);
  if (r) last.current = r;
  const v = r ?? last.current;
  const toast = useToast();
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", "Đã sao chép");
    } catch {
      toast("error", "Không sao chép được");
    }
  };

  const stream = v && v.firstTokenMs != null ? Math.max(0, v.durationMs - v.firstTokenMs) : null;
  const tps = v && stream && stream > 0 && v.output > 0 ? v.output / (stream / 1000) : null;
  const rows: Array<[string, React.ReactNode]> = v
    ? [
        ["Thời gian", new Date(v.ts).toLocaleString("vi-VN")],
        ["Model yêu cầu", <span className="mono" key="m">{v.requestedModel}{v.effort ? ` · ${v.effort}` : ""}</span>],
        ["Model phục vụ", <span className="mono" key="s">{v.model || "–"}</span>],
        ["Tài khoản", v.accountLabel ?? "–"],
        ["Độ trễ toàn phần", ms(v.durationMs)],
        ["Tới token đầu", v.firstTokenMs != null ? ms(v.firstTokenMs) : "–"],
        ["Thời gian stream", stream != null ? ms(stream) : "–"],
        ["Tốc độ sinh", tps ? `${Math.round(tps)} token/s` : "–"],
        ["Token vào", `${num(v.input)}${v.input ? ` (cache ${pct(v.cached / v.input)})` : ""}`],
        ["Token ra", `${num(v.output)}${v.reasoning ? ` (suy luận ${num(v.reasoning)})` : ""}`],
        ["Ứng dụng khách", v.client ?? "–"],
        ["Phiên · IP · máy", [v.session, v.ip, v.device].map((x) => x ?? "–").join(" · ")],
      ]
    : [];

  return (
    <Sheet
      open={!!r}
      onClose={onClose}
      title={v ? `${v.requestedModel}` : ""}
      subtitle={v ? `Yêu cầu #${v.id}` : undefined}
      width={640}
      footer={
        v && (
          <>
            {v.accountId && (
              <Button size="sm" variant="secondary" onClick={() => onFilter({ account: v.accountId! })}>
                Lọc theo tài khoản này
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => onFilter({ model: v.requestedModel })}>
              Lọc theo model này
            </Button>
          </>
        )
      }
    >
      {v && (
        <div className="req-detail">
          <div className="req-status">
            <Pill tone={tone(v.kind)}>{v.kind === "ok" ? `Thành công (${v.status})` : `${kindLabel(v.kind)} (${v.status})`}</Pill>
            {v.kind !== "ok" && <span className="dim small">{KIND_INFO[v.kind].hint}</span>}
          </div>
          <dl className="kv">
            {rows.map(([k, val]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
          {v.error && (
            <div className="req-error">
              <div className="req-error-head">
                <b>Nội dung lỗi</b>
                <Button size="sm" variant="plain" icon={<IconCopy size={13} />} onClick={() => void copy(v.error!)}>
                  Sao chép
                </Button>
              </div>
              <pre>{v.error}</pre>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
