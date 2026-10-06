import { useMemo, useState } from "react";
import { api, errMsg, type PublicAccount, type RangeSel, type Status, type UsageFilter } from "../lib/api.ts";
import { usePoll, useNow, routeHref } from "../lib/hooks.ts";
import { compact, countdown, duration, ms, num, pct, PROVIDERS, providerInfo } from "../lib/format.ts";
import { Card, Empty, ErrorBanner, PageHeader, Pill, ProviderGlyph, SectionHeader, Segmented, Skeleton, useToast } from "../components/ui.tsx";
import { Sparkline, TimelineChart } from "../components/chart.tsx";
import { IconBolt, IconCopy, IconCube, IconGauge, IconPeople } from "../components/icons.tsx";
import { BarList, Delta, Heat, Ladder, Meter, RangePicker, StackBar, errorKindParts } from "../components/stats.tsx";
import { bucketLabel, delta, heatmap, rebucket } from "../lib/stats.ts";
import { forecast, quotaBars, type Forecast, type QuotaBar } from "../lib/quota.ts";

const RANGE_KEY = "ch.overview.range";

function loadRange(): RangeSel {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v === "24h" || v === "7d" || v === "30d") return { key: v };
  } catch {
    /* storage can be blocked: fall back to the default */
  }
  return { key: "24h" };
}

const fmtDay = (t: number) => new Date(t).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function OverviewPage({
  status,
  statusAt,
  statusError,
  accounts,
  go,
}: {
  status: Status | undefined;
  statusAt: number;
  statusError: string | null;
  accounts: PublicAccount[] | undefined;
  go: (r: "accounts") => void;
}) {
  const [range, setRange] = useState<RangeSel>(loadRange);
  const [provider, setProvider] = useState<string>("");
  const [metric, setMetric] = useState<"requests" | "tokens" | "errors">("requests");
  const now = useNow(1000);
  const toast = useToast();

  const filter: UsageFilter = { provider: (provider || undefined) as UsageFilter["provider"] };
  const rangeId = range.key === "custom" ? `${range.from}-${range.to}` : range.key;
  const key = `${rangeId}|${provider}`;
  const usage = usePoll(() => api.usage(range, filter), 30_000, key);

  const pickRange = (r: RangeSel) => {
    setRange(r);
    try {
      if (r.key !== "custom") localStorage.setItem(RANGE_KEY, r.key);
    } catch {
      /* ignore */
    }
  };

  const u = usage.data;
  const t = u?.totals;
  const series = useMemo(() => (u ? rebucket(u.hourly, u.range.since, u.range.until) : null), [u]);
  const heat = useMemo(() => (u ? heatmap(u.hourly) : null), [u]);
  const multiDay = !!u && u.range.until - u.range.since > 26 * 3600_000;
  const fmtTime = (ts: number) => bucketLabel(ts, series?.kind ?? "hour", multiDay);

  const errors = t?.errors ?? 0;
  const cachedRate = t && t.input > 0 ? t.cached / t.input : NaN;
  const errRate = t && t.requests > 0 ? errors / t.requests : NaN;
  const prev = u?.prev;
  const prevErrRate = prev && prev.requests > 0 ? prev.errors / prev.requests : null;
  const prevCache = prev && prev.input > 0 ? prev.cached / prev.input : null;

  const running = !!status && !statusError;
  const uptime = status ? status.uptimeMs + (now - statusAt) : 0;
  const baseUrl = status ? `http://127.0.0.1:${status.port}/v1` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      toast("success", "Đã sao chép địa chỉ", baseUrl);
    } catch {
      toast("error", "Không sao chép được");
    }
  };

  const kpis: Array<{ label: string; value: string | null; sub?: string; spark?: number[]; color?: string; tone?: string; delta?: ReturnType<typeof delta>; deltaDigits?: number }> = [
    { label: "Yêu cầu", value: t ? num(t.requests) : null, spark: series?.requests, color: "var(--accent)", delta: delta(t?.requests, prev?.requests) },
    { label: "Token vào", value: t ? compact(t.input) : null, spark: series?.input, color: "var(--tint-teal)", delta: delta(t?.input, prev?.input) },
    { label: "Token ra", value: t ? compact(t.output) : null, spark: series?.output, color: "var(--tint-purple)", delta: delta(t?.output, prev?.output) },
    { label: "Tỉ lệ cache", value: t ? pct(cachedRate) : null, sub: t ? `${compact(t.cached)} token đọc từ cache` : "", delta: delta(cachedRate, prevCache, "down") },
    { label: "Tỉ lệ lỗi", value: t ? pct(errRate, 1) : null, sub: t ? `${num(errors)} lỗi` : "", tone: errRate > 0.05 ? "bad" : "", delta: delta(errRate, prevErrRate, "up") },
    { label: "Độ trễ trung vị", value: u ? ms(u.latency.p50) : null, sub: u ? `p95 ${ms(u.latency.p95)} · p99 ${ms(u.latency.p99)}` : "", delta: delta(t?.avgMs, prev?.avgMs, "up") },
    { label: "Tới token đầu", value: u ? ms(u.latency.ttftP50) : null, sub: u ? `p95 ${ms(u.latency.ttftP95)} · p99 ${ms(u.latency.ttftP99)}` : "" },
    { label: "Tốc độ sinh", value: u ? (u.tokensPerSec ? `${Math.round(u.tokensPerSec)} token/s` : "–") : null, sub: "Không tính thời gian chờ token đầu" },
  ];

  const chartSeries = !series
    ? []
    : metric === "requests"
      ? [
          { key: "req", label: "Yêu cầu", color: "var(--accent)", values: series.requests },
          { key: "err", label: "Lỗi", color: "var(--tint-red)", values: series.errors },
        ]
      : metric === "tokens"
        ? [
            { key: "in", label: "Token vào", color: "var(--tint-teal)", values: series.input },
            { key: "out", label: "Token ra", color: "var(--tint-purple)", values: series.output },
          ]
        : [{ key: "rate", label: "Tỉ lệ lỗi", color: "var(--tint-red)", values: series.requests.map((r, i) => (r > 0 ? (series.errors[i]! / r) * 100 : 0)) }];
  const fmtPct = (v: number) => `${v.toFixed(v < 10 && v % 1 ? 1 : 0)}%`;

  return (
    <div className="page wide">
      <PageHeader title="Tổng quan" subtitle="Tình trạng proxy và mức sử dụng của Codex qua Code Hole." />

      {statusError && <ErrorBanner message={`Không lấy được trạng thái: ${statusError}`} />}

      <section className="hero card" aria-label="Trạng thái máy chủ">
        <div className="hero-main">
          <span className={`hero-orb ${running ? "live" : "down"}`} aria-hidden="true">
            <span />
          </span>
          <div>
            <div className="hero-title">{status ? (running ? "Code Hole đang chạy" : "Mất kết nối") : "Đang kết nối…"}</div>
            <div className="hero-sub">
              {status ? (
                <>
                  Phiên bản {status.version} · hoạt động {duration(uptime)}
                </>
              ) : (
                <Skeleton w={180} h={14} />
              )}
            </div>
          </div>
        </div>
        <div className="hero-facts">
          <div className="fact">
            <span className="fact-label">Cổng</span>
            <span className="fact-value mono">{status?.port ?? "–"}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Địa chỉ cho Codex</span>
            <span className="fact-value mono with-action">
              {baseUrl || "–"}
              {baseUrl && (
                <button className="icon-btn subtle" onClick={copy} aria-label="Sao chép địa chỉ">
                  <IconCopy size={14} />
                </button>
              )}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Tài khoản sẵn sàng</span>
            <span className="fact-value">
              {status ? num(status.providers.reduce((a, p) => a + p.enabled, 0)) : "–"}
              <span className="fact-dim"> / {status ? num(status.providers.reduce((a, p) => a + p.accounts, 0)) : "–"}</span>
            </span>
          </div>
        </div>
      </section>

      <div className="provider-grid">
        {PROVIDERS.map((p) => {
          const s = status?.providers.find((x) => x.id === p.id);
          const accs = (accounts ?? []).filter((a) => a.provider === p.id);
          const reauth = accs.filter((a) => a.status !== "ok").length;
          const cooling = accs.filter((a) => a.cooldowns.some((c) => c.until > now)).length;
          const tone = !s || s.accounts === 0 ? "gray" : s.enabled === 0 ? "red" : reauth || cooling ? "orange" : "green";
          const label =
            !s || s.accounts === 0 ? "Chưa có tài khoản" : s.enabled === 0 ? "Không khả dụng" : reauth ? `${reauth} cần đăng nhập lại` : cooling ? `${cooling} đang tạm nghỉ` : "Hoạt động tốt";
          return (
            <button key={p.id} className="card provider-card" onClick={() => go("accounts")} aria-label={`${p.name}: ${label}. Mở trang tài khoản`}>
              <div className="provider-card-top">
                <ProviderGlyph id={p.id} size={34} />
                <Pill tone={tone}>{label}</Pill>
              </div>
              <div className="provider-card-name">{p.name}</div>
              <div className="provider-card-meta">
                {s ? (
                  <>
                    <b>{s.enabled}</b> / {s.accounts} tài khoản sẵn sàng
                  </>
                ) : (
                  <Skeleton w={120} h={12} />
                )}
              </div>
            </button>
          );
        })}
      </div>

      <HealthPanel accounts={accounts} now={now} go={go} />

      <SectionHeader title="Mức sử dụng">
        <RangePicker value={range} onChange={pickRange} />
      </SectionHeader>

      <div className="filter-bar" role="group" aria-label="Bộ lọc thống kê">
        <label className="select">
          <span className="sr-only">Nhà cung cấp</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Nhà cung cấp">
            <option value="">Mọi nhà cung cấp</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {u && (
          <span className="filter-note">
            {fmtDay(u.range.since)} → {fmtDay(u.range.until)}
          </span>
        )}
      </div>

      {usage.error && !usage.data && <ErrorBanner message={`Không tải được thống kê: ${usage.error}`} onRetry={usage.reload} />}

      <div className="kpi-grid kpi-8">
        {kpis.map((k) => (
          <Card key={k.label} className={`kpi ${k.tone === "bad" ? "kpi-bad" : ""}`}>
            <div className="kpi-label">
              <span>{k.label}</span>
              {u && k.delta !== undefined && <Delta info={k.delta} digits={k.deltaDigits} />}
            </div>
            <div className="kpi-value">{k.value ?? <Skeleton w={72} h={26} />}</div>
            {k.spark ? <Sparkline values={k.spark} color={k.color} /> : <div className="kpi-sub">{k.sub}</div>}
            {k.spark && k.sub && <div className="kpi-sub">{k.sub}</div>}
          </Card>
        ))}
      </div>

      <Card className="chart-card">
        <div className="card-head">
          <div>
            <h3>Dòng thời gian</h3>
            <p className="card-sub">{series?.kind === "day" ? "Theo ngày" : series?.kind === "6h" ? "Mỗi 6 giờ" : "Theo giờ"} · giờ địa phương</p>
          </div>
          <div className="chart-head-right">
            <div className="legend">
              {chartSeries.map((s) => (
                <span key={s.key}>
                  <i style={{ background: s.color }} /> {s.label}
                </span>
              ))}
            </div>
            <Segmented
              label="Chỉ số biểu đồ"
              value={metric}
              onChange={setMetric}
              options={[
                { value: "requests", label: "Yêu cầu" },
                { value: "tokens", label: "Token" },
                { value: "errors", label: "Tỉ lệ lỗi" },
              ]}
            />
          </div>
        </div>
        {usage.loading && !u ? (
          <Skeleton h={220} r={12} />
        ) : (
          <TimelineChart
            ariaLabel={metric === "requests" ? "Biểu đồ số yêu cầu và lỗi theo thời gian" : metric === "tokens" ? "Biểu đồ token theo thời gian" : "Biểu đồ tỉ lệ lỗi theo thời gian"}
            times={series?.times ?? []}
            formatTime={fmtTime}
            series={chartSeries}
            format={metric === "errors" ? fmtPct : undefined}
          />
        )}
      </Card>

      <div className="two-col">
        <Card>
          <div className="card-head">
            <div>
              <h3>Độ trễ</h3>
              <p className="card-sub">Chỉ tính yêu cầu thành công</p>
            </div>
          </div>
          {u ? (
            <div className="ladders">
              <div>
                <div className="ladder-title">Toàn phần</div>
                <Ladder rows={[{ label: "p50", ms: u.latency.p50, color: "var(--tint-green)" }, { label: "p95", ms: u.latency.p95, color: "var(--tint-orange)" }, { label: "p99", ms: u.latency.p99, color: "var(--tint-red)" }]} />
              </div>
              <div>
                <div className="ladder-title">Tới token đầu</div>
                <Ladder rows={[{ label: "p50", ms: u.latency.ttftP50, color: "var(--tint-green)" }, { label: "p95", ms: u.latency.ttftP95, color: "var(--tint-orange)" }, { label: "p99", ms: u.latency.ttftP99, color: "var(--tint-red)" }]} />
              </div>
            </div>
          ) : (
            <Skeleton h={120} />
          )}
        </Card>
        <Card>
          <div className="card-head">
            <div>
              <h3>Cơ cấu lỗi</h3>
              <p className="card-sub">{t ? `${num(errors)} lỗi trên ${num(t.requests)} yêu cầu` : ""}</p>
            </div>
            {errors > 0 && (
              <a className="link-btn" href={routeHref("activity", { status: "err" })}>
                Xem trong Nhật ký
              </a>
            )}
          </div>
          {u ? <StackBar parts={errorKindParts(u.errorKinds)} /> : <Skeleton h={100} />}
        </Card>
      </div>

      <div className="two-col">
        <Card>
          <div className="card-head">
            <div>
              <h3>Giờ cao điểm</h3>
              <p className="card-sub">Số yêu cầu theo thứ và giờ trong ngày</p>
            </div>
          </div>
          {heat ? <Heat grid={heat.grid} max={heat.max} /> : <Skeleton h={190} />}
        </Card>
        <Card>
          <div className="card-head">
            <div>
              <h3>Mức suy luận</h3>
              <p className="card-sub">Effort được yêu cầu theo model</p>
            </div>
          </div>
          {u ? (
            <div className="stack-blocks">
              <BarList
                items={u.byEffort.slice(0, 6).map((e) => ({
                  key: e.effort ?? "none",
                  label: <span className="mono">{e.effort ?? "mặc định"}</span>,
                  value: e.requests,
                  valueText: num(e.requests),
                  extra: e.output > 0 ? `${pct(e.reasoning / e.output)} suy luận` : undefined,
                  color: "var(--tint-purple)",
                }))}
              />
            </div>
          ) : (
            <Skeleton h={190} />
          )}
        </Card>
      </div>

      <div className="two-col">
        <Card>
          <div className="card-head">
            <h3>Model dùng nhiều</h3>
          </div>
          {u && u.byModel.length === 0 ? (
            <Empty icon={<IconCube size={26} />} title="Chưa có yêu cầu nào">
              Khi Codex gửi yêu cầu qua Code Hole, model được dùng sẽ hiện ở đây.
            </Empty>
          ) : u ? (
            <BarList
              items={u.byModel.slice(0, 8).map((m) => ({
                key: `${m.provider}:${m.model}`,
                label: (
                  <>
                    <ProviderGlyph id={m.provider} size={20} />
                    <span className="mono ellipsis" title={m.model}>
                      {m.model}
                    </span>
                  </>
                ),
                value: m.requests,
                valueText: num(m.requests),
                extra: `${compact(m.input + m.output)} token${m.errors > 0 ? ` · ${pct(m.errors / m.requests, 1)} lỗi` : ""}`,
                color: providerInfo(m.provider).tint,
              }))}
            />
          ) : (
            [0, 1, 2].map((i) => <Skeleton key={i} h={30} />)
          )}
        </Card>
        <Card>
          <div className="card-head">
            <div>
              <h3>Theo tài khoản</h3>
              {u && u.accountsTotal > 8 && <p className="card-sub">Top 8 trên {num(u.accountsTotal)} nguồn</p>}
            </div>
          </div>
          {u && u.byAccount.length === 0 ? (
            <Empty
              icon={<IconPeople size={26} />}
              title="Chưa có dữ liệu"
              action={
                (accounts?.length ?? 0) === 0 ? (
                  <button className="btn btn-tinted btn-sm" onClick={() => go("accounts")}>
                    <span>Thêm tài khoản</span>
                  </button>
                ) : undefined
              }
            >
              Mức dùng của từng tài khoản sẽ hiện ở đây.
            </Empty>
          ) : u ? (
            <BarList
              items={u.byAccount.slice(0, 8).map((a) => {
                const name = a.label ?? a.email ?? (a.accountId ? "Tài khoản đã xoá" : "Không có tài khoản");
                return {
                  key: a.accountId ?? "none",
                  label: (
                    <>
                      <ProviderGlyph id={a.provider} size={20} />
                      <span className="ellipsis">{name}</span>
                    </>
                  ),
                  value: a.requests,
                  valueText: num(a.requests),
                  extra: a.errors > 0 ? <span className="rank-bad">{num(a.errors)} lỗi</span> : `${compact(a.input + a.output)} token`,
                  color: providerInfo(a.provider).tint,
                };
              })}
            />
          ) : (
            [0, 1, 2].map((i) => <Skeleton key={i} h={30} />)
          )}
        </Card>
      </div>

      <p className="footnote">
        <IconBolt size={13} /> Số liệu tự làm mới mỗi 30 giây, trạng thái mỗi 10 giây. <IconGauge size={13} /> Kỳ trước là khoảng thời gian cùng độ dài ngay trước kỳ này.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// quota + cooldown
// ---------------------------------------------------------------------------

interface HealthRow {
  account: PublicAccount;
  bars: Array<{ bar: QuotaBar; fc: Forecast }>;
  cooldowns: PublicAccount["cooldowns"];
  urgency: number;
}

function HealthPanel({ accounts, now, go }: { accounts: PublicAccount[] | undefined; now: number; go: (r: "accounts") => void }) {
  const rows = useMemo<HealthRow[]>(() => {
    const out: HealthRow[] = [];
    for (const a of accounts ?? []) {
      const bars = quotaBars(a.quota).map((bar) => ({ bar, fc: forecast(bar, now) }));
      const cooldowns = a.cooldowns.filter((c) => c.until > now);
      const reauth = a.status !== "ok";
      if (bars.length === 0 && cooldowns.length === 0 && !reauth) continue;
      const urgency =
        (reauth ? 3 : 0) +
        (cooldowns.length ? 2 : 0) +
        Math.max(0, ...bars.map(({ bar, fc }) => (fc.state === "exhausted" ? 3 : fc.state === "will-exhaust" ? 2 : bar.used >= 0.9 ? 1.5 : bar.used >= 0.7 ? 1 : 0)));
      out.push({ account: a, bars, cooldowns, urgency });
    }
    return out.sort((x, y) => y.urgency - x.urgency);
    // `now` ticks every second: quota forecasts only need minute precision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, Math.floor(now / 30_000)]);

  if (!accounts || rows.length === 0) return null;
  const hot = rows.filter((r) => r.urgency >= 2).length;
  return (
    <Card>
      <div className="card-head">
        <div>
          <h3>Hạn mức và tạm nghỉ</h3>
          <p className="card-sub">{hot > 0 ? `${hot} tài khoản cần chú ý` : "Các cửa sổ hạn mức của từng tài khoản"}</p>
        </div>
        <button className="link-btn" onClick={() => go("accounts")}>
          Mở trang tài khoản
        </button>
      </div>
      <ul className="health">
        {rows.slice(0, 8).map(({ account: a, bars, cooldowns }) => (
          <li key={a.id}>
            <div className="health-id">
              <ProviderGlyph id={a.provider} size={24} />
              <div className="health-name">
                <span className="ellipsis">{a.label}</span>
                <span className="dim small">{providerInfo(a.provider).name}</span>
              </div>
            </div>
            <div className="health-body">
              {(a.status !== "ok" || cooldowns.length > 0) && (
                <div className="health-pills">
                  {a.status !== "ok" && <Pill tone="red">{a.status === "needs_reauth" ? "Cần đăng nhập lại" : "Lỗi"}</Pill>}
                  {cooldowns.map((c) => (
                    <Pill key={c.scope} tone="orange" title={c.reason ?? undefined}>
                      {c.scope === "*" ? "Cả tài khoản" : c.scope} · còn {countdown(c.until - now)}
                    </Pill>
                  ))}
                </div>
              )}
              {bars.length > 0 && (
                <div className="health-bars">
                  {bars.map(({ bar, fc }) => (
                    <Meter key={bar.key} bar={bar} forecast={fc} now={now} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}



// ---------------------------------------------------------------------------
// quota + cooldown
// ---------------------------------------------------------------------------

interface HealthRow {
  account: PublicAccount;
  bars: Array<{ bar: QuotaBar; fc: Forecast }>;
  cooldowns: PublicAccount["cooldowns"];
  urgency: number;
}

function HealthPanel({ accounts, now, go }: { accounts: PublicAccount[] | undefined; now: number; go: (r: "accounts") => void }) {
  const rows = useMemo<HealthRow[]>(() => {
    const out: HealthRow[] = [];
    for (const a of accounts ?? []) {
      const bars = quotaBars(a.quota).map((bar) => ({ bar, fc: forecast(bar, now) }));
      const cooldowns = a.cooldowns.filter((c) => c.until > now);
      const reauth = a.status !== "ok";
      if (bars.length === 0 && cooldowns.length === 0 && !reauth) continue;
      const urgency =
        (reauth ? 3 : 0) +
        (cooldowns.length ? 2 : 0) +
        Math.max(0, ...bars.map(({ bar, fc }) => (fc.state === "exhausted" ? 3 : fc.state === "will-exhaust" ? 2 : bar.used >= 0.9 ? 1.5 : bar.used >= 0.7 ? 1 : 0)));
      out.push({ account: a, bars, cooldowns, urgency });
    }
    return out.sort((x, y) => y.urgency - x.urgency);
    // `now` ticks every second: quota forecasts only need minute precision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, Math.floor(now / 30_000)]);

  if (!accounts || rows.length === 0) return null;
  const hot = rows.filter((r) => r.urgency >= 2).length;
  return (
    <Card>
      <div className="card-head">
        <div>
          <h3>Hạn mức và tạm nghỉ</h3>
          <p className="card-sub">{hot > 0 ? `${hot} tài khoản cần chú ý` : "Các cửa sổ hạn mức của từng tài khoản"}</p>
        </div>
        <button className="link-btn" onClick={() => go("accounts")}>
          Mở trang tài khoản
        </button>
      </div>
      <ul className="health">
        {rows.slice(0, 8).map(({ account: a, bars, cooldowns }) => (
          <li key={a.id}>
            <div className="health-id">
              <ProviderGlyph id={a.provider} size={24} />
              <div className="health-name">
                <span className="ellipsis">{a.label}</span>
                <span className="dim small">{providerInfo(a.provider).name}</span>
              </div>
            </div>
            <div className="health-body">
              {(a.status !== "ok" || cooldowns.length > 0) && (
                <div className="health-pills">
                  {a.status !== "ok" && <Pill tone="red">{a.status === "needs_reauth" ? "Cần đăng nhập lại" : "Lỗi"}</Pill>}
                  {cooldowns.map((c) => (
                    <Pill key={c.scope} tone="orange" title={c.reason ?? undefined}>
                      {c.scope === "*" ? "Cả tài khoản" : c.scope} · còn {countdown(c.until - now)}
                    </Pill>
                  ))}
                </div>
              )}
              {bars.length > 0 && (
                <div className="health-bars">
                  {bars.map(({ bar, fc }) => (
                    <Meter key={bar.key} bar={bar} forecast={fc} now={now} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}


