import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg, type LoginStart, type ProviderId, type PublicAccount } from "../lib/api.ts";
import { useNow } from "../lib/hooks.ts";
import { countdown, dateTime, inShort, pct, PROVIDERS, providerInfo, relTime } from "../lib/format.ts";
import { quotaBars } from "../lib/quota.ts";
import { Button, Empty, ErrorBanner, PageHeader, Pill, ProviderGlyph, Sheet, Skeleton, Spinner, Stepper, Toggle, useToast } from "../components/ui.tsx";
import { IconCheckCircle, IconChevron, IconExternal, IconHourglass, IconKey, IconPeople, IconPlus, IconRefresh, IconTrash, IconWarn } from "../components/icons.tsx";

interface Props {
  accounts: PublicAccount[] | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  mutate: (fn: (prev: PublicAccount[] | undefined) => PublicAccount[] | undefined) => void;
}

export function AccountsPage({ accounts, error, loading, reload, mutate }: Props) {
  const [adding, setAdding] = useState<ProviderId | "pick" | null>(null);
  const [deleting, setDeleting] = useState<PublicAccount | null>(null);
  const now = useNow(1000);

  const replace = (a: PublicAccount) => mutate((list) => list?.map((x) => (x.id === a.id ? a : x)));

  return (
    <div className="page">
      <PageHeader title="Tài khoản" subtitle="Code Hole xoay vòng giữa các tài khoản theo độ ưu tiên và hạn mức còn lại.">
        <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setAdding("pick")}>
          Thêm tài khoản
        </Button>
      </PageHeader>

      {error && <ErrorBanner message={`Không tải được danh sách tài khoản: ${error}`} onRetry={reload} />}

      {loading && !accounts ? (
        <div className="group">
          <Skeleton h={22} w={160} />
          <div className="inset-list">
            {[0, 1].map((i) => (
              <div key={i} className="acct">
                <Skeleton h={48} />
              </div>
            ))}
          </div>
        </div>
      ) : accounts && accounts.length === 0 ? (
        <div className="card">
          <Empty
            icon={<IconPeople size={30} />}
            title="Chưa có tài khoản nào"
            action={
              <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setAdding("pick")}>
                Thêm tài khoản
              </Button>
            }
          >
            Đăng nhập ChatGPT hoặc Antigravity, hoặc thêm khoá OpenCode.
          </Empty>
        </div>
      ) : (
        PROVIDERS.map((p) => {
          const list = (accounts ?? []).filter((a) => a.provider === p.id);
          return (
            <section key={p.id} className="group" aria-labelledby={`grp-${p.id}`}>
              <div className="group-head">
                <ProviderGlyph id={p.id} size={26} />
                <h2 id={`grp-${p.id}`}>{p.name}</h2>
                <span className="group-count">{list.length}</span>
                <span className="spacer" />
                <Button variant="plain" size="sm" icon={<IconPlus size={14} />} onClick={() => setAdding(p.id)} aria-label={`Thêm tài khoản ${p.name}`}>
                  Thêm
                </Button>
              </div>
              {list.length === 0 ? (
                <div className="inset-list">
                  <div className="acct-empty">
                    <span>{p.kind === "oauth" ? "Chưa đăng nhập tài khoản nào." : "Chưa có khoá API nào."}</span>
                    <button className="link" onClick={() => setAdding(p.id)}>
                      {p.kind === "oauth" ? "Đăng nhập" : "Thêm khoá"} <IconChevron size={12} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="inset-list">
                  {list.map((a) => (
                    <AccountRow key={a.id} account={a} now={now} onChange={replace} onDelete={() => setDeleting(a)} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}

      <AddAccountSheet
        target={adding}
        onClose={() => setAdding(null)}
        onPick={(id) => setAdding(id)}
        onAdded={async () => {
          setAdding(null);
          await reload();
        }}
      />

      <DeleteSheet
        account={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setDeleting(null);
          mutate((l) => l?.filter((x) => x.id !== id));
          void reload();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Account row

function AccountRow({ account: a, now, onChange, onDelete }: { account: PublicAccount; now: number; onChange: (a: PublicAccount) => void; onDelete: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(a.label);
  const [priority, setPriority] = useState(a.priority);
  const prioTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setPriority(a.priority), [a.priority]);
  useEffect(() => {
    if (!editing) setLabel(a.label);
  }, [a.label, editing]);

  const cooldowns = a.cooldowns.filter((c) => c.until > now);
  const cooling = cooldowns.length > 0;
  const nextFree = cooling ? Math.max(...cooldowns.map((c) => c.until)) : 0;
  const bars = quotaBars(a.quota);
  const plan = typeof a.meta.plan === "string" ? a.meta.plan : null;
  const projectId = typeof a.meta.projectId === "string" ? a.meta.projectId : null;
  const kind = providerInfo(a.provider).kind;

  const act = async (name: string, fn: () => Promise<PublicAccount>, ok?: string) => {
    setBusy(name);
    try {
      const r = await fn();
      onChange(r);
      if (ok) toast("success", ok);
    } catch (e) {
      toast("error", "Thao tác thất bại", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const setPrio = (v: number) => {
    setPriority(v);
    clearTimeout(prioTimer.current);
    prioTimer.current = setTimeout(() => void act("prio", () => api.patchAccount(a.id, { priority: v })), 450);
  };

  const saveLabel = async () => {
    setEditing(false);
    const v = label.trim();
    if (!v || v === a.label) return setLabel(a.label);
    await act("label", () => api.patchAccount(a.id, { label: v }), "Đã đổi tên");
  };

  const status =
    a.status === "needs_reauth" ? (
      <Pill tone="red" title={a.statusDetail ?? undefined}>
        Cần đăng nhập lại
      </Pill>
    ) : a.status === "error" ? (
      <Pill tone="red" title={a.statusDetail ?? undefined}>
        Lỗi
      </Pill>
    ) : cooling ? (
      <Pill tone="orange" title={cooldowns.map((c) => `${c.scope}: ${c.reason ?? ""}`).join("\n")}>
        Tạm nghỉ · <span className="tabular">{countdown(nextFree - now)}</span>
      </Pill>
    ) : !a.enabled ? (
      <Pill tone="gray">Đã tắt</Pill>
    ) : (
      <Pill tone="green">Sẵn sàng</Pill>
    );

  const initial = (a.label || a.email || "?").trim().charAt(0).toUpperCase();

  return (
    <article className={`acct ${a.enabled ? "" : "is-disabled"}`} aria-label={a.label}>
      <div className="acct-top">
        <span className="avatar" style={{ ["--tint" as string]: providerInfo(a.provider).tint }} aria-hidden="true">
          {kind === "apikey" ? <IconKey size={16} /> : initial}
        </span>
        <div className="acct-id">
          {editing ? (
            <input
              className="inline-input"
              value={label}
              autoFocus
              aria-label="Tên tài khoản"
              onChange={(e) => setLabel(e.target.value)}
              onBlur={saveLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setLabel(a.label);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button className="acct-name" onClick={() => setEditing(true)} title="Nhấn để đổi tên">
              {a.label || a.email || a.id}
            </button>
          )}
          <div className="acct-meta">
            {a.email && a.email !== a.label && <span>{a.email}</span>}
            {plan && <span className="chip">{plan}</span>}
            {projectId && (
              <span className="mono dim" title="Project ID">
                {projectId}
              </span>
            )}
            {a.meta.importedFrom ? <span className="dim">nhập từ {String(a.meta.importedFrom)}</span> : null}
          </div>
        </div>
        <div className="acct-status">{status}</div>
        <Toggle
          checked={a.enabled}
          label={`${a.enabled ? "Tắt" : "Bật"} tài khoản ${a.label}`}
          disabled={busy === "enable"}
          onChange={(v) => {
            onChange({ ...a, enabled: v });
            void act("enable", () => api.patchAccount(a.id, { enabled: v }), v ? "Đã bật tài khoản" : "Đã tắt tài khoản");
          }}
        />
      </div>

      {a.status !== "ok" && a.statusDetail && (
        <div className="acct-note">
          <IconWarn size={14} /> {a.statusDetail}
        </div>
      )}

      {bars.length > 0 && (
        <div className="quota">
          {bars.map((b) => {
            const tone = b.used >= 0.9 ? "red" : b.used >= 0.7 ? "orange" : "green";
            return (
              <div key={b.key} className="quota-item">
                <div className="quota-row">
                  <span className="quota-label">{b.label}</span>
                  <span className="quota-val" title={b.resetAt ? `Đặt lại lúc ${dateTime(b.resetAt)}` : undefined}>
                    {b.mode === "remaining" ? `còn ${pct(1 - b.used)}` : `đã dùng ${pct(b.used)}`}
                    {b.resetAt && b.resetAt > now && <span className="dim"> · đặt lại sau {inShort(b.resetAt - now)}</span>}
                  </span>
                </div>
                <div
                  className={`meter meter-${tone}`}
                  role="meter"
                  aria-label={`${b.label}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((b.mode === "remaining" ? 1 - b.used : b.used) * 100)}
                  aria-valuetext={b.mode === "remaining" ? `còn ${pct(1 - b.used)}` : `đã dùng ${pct(b.used)}`}
                >
                  <span style={{ width: `${Math.max(1.5, (b.mode === "remaining" ? 1 - b.used : b.used) * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="acct-actions">
        <label className="prio">
          <span>Ưu tiên</span>
          <Stepper value={priority} onChange={setPrio} label="Độ ưu tiên" />
        </label>
        <span className="dim small">
          {a.quota?.updatedAt ? `Hạn mức cập nhật ${relTime(a.quota.updatedAt, now)}` : kind === "oauth" ? "Chưa có dữ liệu hạn mức" : ""}
        </span>
        <span className="spacer" />
        {cooling && (
          <Button size="sm" variant="plain" icon={<IconHourglass size={14} />} busy={busy === "cool"} onClick={() => act("cool", () => api.clearCooldown(a.id), "Đã bỏ tạm nghỉ")}>
            Bỏ tạm nghỉ
          </Button>
        )}
        <Button size="sm" variant="plain" icon={<IconRefresh size={14} />} busy={busy === "quota"} onClick={() => act("quota", () => api.refreshQuota(a.id), "Đã làm mới hạn mức")}>
          Làm mới hạn mức
        </Button>
        <button className="icon-btn danger" onClick={onDelete} aria-label={`Xoá tài khoản ${a.label}`} title="Xoá">
          <IconTrash size={16} />
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- Add account

function AddAccountSheet({
  target,
  onClose,
  onPick,
  onAdded,
}: {
  target: ProviderId | "pick" | null;
  onClose: () => void;
  onPick: (id: ProviderId) => void;
  onAdded: () => void;
}) {
  // Keep rendering the last target while the sheet animates out; count opens so a re-opened
  // flow remounts with fresh state.
  const [last, setLast] = useState<ProviderId | "pick" | null>(null);
  useEffect(() => {
    if (target) setLast(target);
  }, [target]);
  const openCount = useRef(0);
  const wasOpen = useRef(false);
  if (target && !wasOpen.current) openCount.current++;
  wasOpen.current = !!target;
  const t = target ?? last;
  const info = t && t !== "pick" ? providerInfo(t) : null;
  const title = info ? (info.kind === "oauth" ? `Đăng nhập ${info.name}` : `Thêm khoá ${info.name}`) : "Thêm tài khoản";
  const k = `${t}-${openCount.current}`;

  return (
    <Sheet open={!!target} onClose={onClose} title={title} subtitle={info ? info.blurb : "Chọn nhà cung cấp để bắt đầu."}>
      {t === "pick" && (
        <div className="picker">
          {PROVIDERS.map((p) => (
            <button key={p.id} className="picker-item" onClick={() => onPick(p.id)}>
              <ProviderGlyph id={p.id} size={36} />
              <span className="picker-text">
                <b>{p.name}</b>
                <span>{p.kind === "oauth" ? "Đăng nhập qua trình duyệt" : "Dùng khoá API"}</span>
              </span>
              <IconChevron size={14} className="picker-chev" />
            </button>
          ))}
        </div>
      )}
      {t && t !== "pick" && info?.kind === "oauth" && <OAuthFlow key={k} provider={t} onDone={onAdded} />}
      {t && t !== "pick" && info?.kind === "apikey" && <ApiKeyForm key={k} provider={t} onDone={onAdded} />}
    </Sheet>
  );
}

function OAuthFlow({ provider, onDone }: { provider: ProviderId; onDone: () => void }) {
  const toast = useToast();
  const [device, setDevice] = useState(false);
  const [start, setStart] = useState<LoginStart | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const loginRef = useRef<string | null>(null);
  const info = providerInfo(provider);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // Cancel a pending login if the sheet closes mid-flow.
  useEffect(
    () => () => {
      if (loginRef.current) void api.loginCancel(provider, loginRef.current).catch(() => {});
    },
    [provider],
  );

  useEffect(() => {
    if (phase !== "waiting" || !start) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.loginStatus(provider, start.loginId);
        if (stop) return;
        if (s.state === "done") {
          loginRef.current = null;
          setPhase("done");
          toast("success", `Đã thêm tài khoản ${info.name}`, s.email ?? undefined);
          setTimeout(() => doneRef.current(), 900);
        } else if (s.state === "error") {
          loginRef.current = null;
          setPhase("error");
          setErr(s.message);
        }
      } catch (e) {
        if (!stop) {
          setPhase("error");
          setErr(errMsg(e));
        }
      }
    };
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [phase, start, provider, info.name, toast]);

  const begin = useCallback(async () => {
    setPhase("starting");
    setErr(null);
    try {
      const s = await api.loginStart(provider, device);
      setStart(s);
      loginRef.current = s.loginId;
      setPhase("waiting");
      const url = s.authUrl ?? s.verificationUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setPhase("error");
      setErr(errMsg(e));
    }
  }, [provider, device]);

  const cancel = async () => {
    if (start) await api.loginCancel(provider, start.loginId).catch(() => {});
    loginRef.current = null;
    setStart(null);
    setPhase("idle");
  };

  if (phase === "done")
    return (
      <div className="flow-state">
        <span className="flow-icon ok">
          <IconCheckCircle size={40} />
        </span>
        <h3>Đăng nhập thành công</h3>
      </div>
    );

  if (phase === "waiting" && start) {
    const url = start.verificationUrl ?? start.authUrl;
    return (
      <div className="flow-state">
        {start.userCode ? (
          <>
            <p className="flow-lead">Mở trang xác minh và nhập mã sau:</p>
            <div className="device-code" aria-label="Mã thiết bị">
              {start.userCode.split("").map((c, i) => (
                <span key={i} className={c === "-" ? "sep" : ""}>
                  {c}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="plain"
              onClick={() => navigator.clipboard.writeText(start.userCode!).then(() => toast("success", "Đã sao chép mã"), () => {})}
            >
              Sao chép mã
            </Button>
          </>
        ) : (
          <p className="flow-lead">Hoàn tất đăng nhập trong tab trình duyệt vừa mở. Cửa sổ này sẽ tự cập nhật.</p>
        )}
        <div className="waiting">
          <Spinner size={18} /> Đang chờ xác nhận…
        </div>
        <div className="row gap-s center">
          {url && (
            <a className="btn btn-tinted btn-md" href={url} target="_blank" rel="noopener noreferrer">
              <IconExternal size={15} />
              <span>Mở lại trang đăng nhập</span>
            </a>
          )}
          <Button variant="secondary" onClick={cancel}>
            Huỷ
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow">
      <ol className="steps">
        <li>Code Hole mở trang đăng nhập {info.name} trong tab mới.</li>
        <li>Đăng nhập và cho phép truy cập.</li>
        <li>Tài khoản xuất hiện ở đây. Token được lưu cục bộ và không bao giờ hiển thị.</li>
      </ol>
      {provider === "chatgpt" && (
        <label className="setting-row">
          <span>
            <b>Dùng mã thiết bị</b>
            <span className="dim small">Hữu ích khi trình duyệt ở máy khác.</span>
          </span>
          <Toggle checked={device} onChange={setDevice} label="Dùng mã thiết bị" />
        </label>
      )}
      {phase === "error" && err && <ErrorBanner message={err} />}
      <div className="sheet-actions">
        <Button variant="primary" size="lg" busy={phase === "starting"} onClick={begin} data-autofocus icon={<IconExternal size={16} />}>
          {phase === "error" ? "Thử lại" : `Tiếp tục với ${info.name}`}
        </Button>
      </div>
    </div>
  );
}

function ApiKeyForm({ provider, onDone }: { provider: ProviderId; onDone: () => void }) {
  const toast = useToast();
  const info = providerInfo(provider);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return setErr("Vui lòng nhập khoá API.");
    setBusy(true);
    setErr(null);
    try {
      await api.addApiKey(provider, key.trim(), label.trim() || info.name);
      setKey("");
      toast("success", `Đã thêm khoá ${info.name}`);
      onDone();
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Tên hiển thị</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={info.name} autoComplete="off" data-autofocus />
      </label>
      <label className="field">
        <span>Khoá API</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          className="mono"
          aria-invalid={!!err}
        />
        <small className="dim">Khoá được kiểm tra rồi lưu cục bộ. Code Hole không hiển thị lại khoá.</small>
      </label>
      {err && <ErrorBanner message={err} />}
      <div className="sheet-actions">
        <Button type="submit" variant="primary" size="lg" busy={busy} icon={<IconKey size={16} />}>
          Thêm khoá
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Delete

function DeleteSheet({ account, onClose, onDeleted }: { account: PublicAccount | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(account);
  useEffect(() => {
    if (account) setLast(account);
  }, [account]);
  const a = account ?? last;

  const run = async () => {
    if (!a) return;
    setBusy(true);
    try {
      await api.deleteAccount(a.id);
      toast("success", "Đã xoá tài khoản", a.label);
      onDeleted(a.id);
    } catch (e) {
      toast("error", "Không xoá được", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!account}
      onClose={onClose}
      title="Xoá tài khoản?"
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Huỷ
          </Button>
          <Button variant="danger" busy={busy} onClick={run} icon={<IconTrash size={15} />}>
            Xoá
          </Button>
        </>
      }
    >
      {a && (
        <div className="confirm">
          <ProviderGlyph id={a.provider} size={40} />
          <p>
            <b>{a.label}</b>
            {a.email && a.email !== a.label ? ` (${a.email})` : ""} sẽ bị xoá khỏi Code Hole cùng hạn mức và trạng thái tạm nghỉ. Bạn có thể đăng nhập lại bất cứ lúc nào.
          </p>
        </div>
      )}
    </Sheet>
  );
}
