import { useState } from "react";
import { api, errMsg, type CatalogModel, type HarnessSyncResult, type SyncResult } from "../lib/api.ts";
import { usePoll } from "../lib/hooks.ts";
import { contextWindow, num, PROVIDERS } from "../lib/format.ts";
import { Button, Card, Empty, ErrorBanner, PageHeader, ProviderGlyph, Sheet, Skeleton, useToast } from "../components/ui.tsx";
import { IconArrowSync, IconBrain, IconCheckCircle, IconChevron, IconCube, IconDoc, IconPhoto, IconUnlink } from "../components/icons.tsx";

const EFFORT: Record<string, string> = { none: "Không", minimal: "Tối thiểu", low: "Thấp", medium: "Vừa", high: "Cao", xhigh: "Rất cao", max: "Tối đa", ultra: "Siêu cao" };

function ModelRow({ m }: { m: CatalogModel }) {
  const image = m.inputModalities?.includes("image");
  return (
    <li className="model">
      <div className="model-main">
        <div className="model-name">{m.displayName || m.slug}</div>
        {m.displayName && m.displayName !== m.slug && <div className="model-slug mono">{m.slug}</div>}
      </div>
      <div className="model-tags">
        <span className="tag" title="Cửa sổ ngữ cảnh">
          <IconDoc size={13} /> {contextWindow(m.contextWindow)}
        </span>
        {m.reasoningLevels?.length > 0 && (
          <span className="tag" title={`Mức suy luận: ${m.reasoningLevels.map((r) => EFFORT[r] ?? r).join(", ")}${m.defaultReasoning ? ` (mặc định: ${EFFORT[m.defaultReasoning] ?? m.defaultReasoning})` : ""}`}>
            <IconBrain size={13} />
            <span className="effort-dots" aria-label={`${m.reasoningLevels.length} mức suy luận`}>
              {m.reasoningLevels.map((r) => (
                <i key={r} className={r === m.defaultReasoning ? "def" : ""} />
              ))}
            </span>
            {EFFORT[m.defaultReasoning] ?? m.defaultReasoning}
          </span>
        )}
        <span className={`tag ${image ? "" : "tag-off"}`} title={image ? "Hỗ trợ ảnh đầu vào" : "Chỉ văn bản"}>
          <IconPhoto size={13} /> {image ? "Ảnh" : "Văn bản"}
        </span>
      </div>
    </li>
  );
}

export function ModelsPage() {
  const toast = useToast();
  const models = usePoll(() => api.models(), 0);
  const [syncing, setSyncing] = useState(false);
  const [unsyncing, setUnsyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [confirmUnsync, setConfirmUnsync] = useState(false);
  const [harnessSyncing, setHarnessSyncing] = useState(false);
  const [harnessResult, setHarnessResult] = useState<HarnessSyncResult | null>(null);

  const list = models.data ?? [];
  const visible = list.filter((m) => !m.hidden);
  const hidden = list.filter((m) => m.hidden);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.sync();
      setResult(r);
      toast("success", `Đã đồng bộ ${num(r.models)} model xuống Codex`, "Khởi động lại Codex để áp dụng.");
    } catch (e) {
      toast("error", "Đồng bộ thất bại", errMsg(e));
    } finally {
      setSyncing(false);
    }
  };

  const unsync = async () => {
    setUnsyncing(true);
    try {
      const r = await api.unsync();
      setResult(null);
      setConfirmUnsync(false);
      toast(r.ok ? "success" : "info", r.ok ? "Đã gỡ đồng bộ khỏi Codex" : "Không tìm thấy cấu hình Codex để gỡ");
    } catch (e) {
      toast("error", "Gỡ đồng bộ thất bại", errMsg(e));
    } finally {
      setUnsyncing(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Models" subtitle="Danh sách model Code Hole cung cấp cho Codex, theo các tài khoản đang bật." />

      <Card className="sync-card">
        <div className="sync-art" aria-hidden="true">
          <IconArrowSync size={30} />
        </div>
        <div className="sync-text">
          <h3>Đồng bộ xuống Codex</h3>
          <p>
            Ghi danh mục model và trỏ <span className="mono">config.toml</span> của Codex về Code Hole. File cấu hình cũ được sao lưu trước khi
            ghi.
          </p>
        </div>
        <div className="sync-actions">
          <Button variant="primary" size="lg" busy={syncing} onClick={sync} icon={<IconArrowSync size={16} />}>
            Đồng bộ xuống Codex
          </Button>
          <Button variant="plain" size="sm" onClick={() => setConfirmUnsync(true)} icon={<IconUnlink size={14} />}>
            Gỡ đồng bộ
          </Button>
        </div>
        {result && (
          <div className="sync-result" role="status">
            <IconCheckCircle size={18} />
            <dl>
              <div>
                <dt>Số model</dt>
                <dd>{num(result.models)}</dd>
              </div>
              <div>
                <dt>Danh mục</dt>
                <dd className="mono">{result.catalogPath}</dd>
              </div>
              <div>
                <dt>Cấu hình</dt>
                <dd className="mono">{result.configPath}</dd>
              </div>
              <div>
                <dt>Bản sao lưu</dt>
                <dd className="mono">{result.backup ?? "Không cần (chưa có file cũ)"}</dd>
              </div>
            </dl>
          </div>
        )}
      </Card>

      <Card className="sync-card">
        <div className="sync-art" aria-hidden="true">
          <IconArrowSync size={30} />
        </div>
        <div className="sync-text">
          <h3>Đồng bộ sang harness khác</h3>
          <p>
            Thêm provider <span className="mono">chrelay</span> trỏ về Code Hole vào cấu hình của ZCode, OpenCode, OMP và Pi đang cài trên máy. File cũ
            được sao lưu trước khi ghi.
          </p>
        </div>
        <div className="sync-actions">
          <Button
            variant="secondary"
            size="lg"
            busy={harnessSyncing}
            onClick={async () => {
              setHarnessSyncing(true);
              try {
                const r = await api.syncHarnesses();
                setHarnessResult(r);
                const ok = r.results.filter((x) => x.status === "synced").length;
                const bad = r.results.filter((x) => x.status === "error").length;
                toast(bad ? "error" : "success", `Đã đồng bộ ${ok}/${r.results.length} harness`, bad ? `${bad} harness lỗi — xem chi tiết bên dưới.` : undefined);
              } catch (e) {
                toast("error", "Đồng bộ harness thất bại", errMsg(e));
              } finally {
                setHarnessSyncing(false);
              }
            }}
            icon={<IconArrowSync size={16} />}
          >
            Đồng bộ harness
          </Button>
        </div>
        {harnessResult && (
          <div className="sync-result" role="status">
            <IconCheckCircle size={18} />
            <ul className="harness-list">
              {harnessResult.results.map((r) => (
                <li key={r.id} className={`harness-row harness-${r.status}`}>
                  <span className="harness-name">{r.name}</span>
                  <span className={`tag ${r.status === "synced" ? "" : "tag-off"}`}>
                    {r.status === "synced" ? `OK · ${num(r.models ?? 0)} model` : r.status === "skipped" ? `Bỏ qua — ${r.message}` : `Lỗi — ${r.message}`}
                  </span>
                  {r.path ? <span className="mono dim harness-path">{r.path}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {models.error && <ErrorBanner message={`Không tải được danh sách model: ${models.error}`} onRetry={models.reload} />}

      {models.loading && !models.data ? (
        <Card>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ padding: "10px 0" }}>
              <Skeleton h={34} />
            </div>
          ))}
        </Card>
      ) : list.length === 0 && !models.error ? (
        <Card>
          <Empty icon={<IconCube size={30} />} title="Chưa có model nào">
            Model xuất hiện khi có ít nhất một tài khoản đang bật cho nhà cung cấp tương ứng.
          </Empty>
        </Card>
      ) : (
        PROVIDERS.map((p) => {
          const ms = visible.filter((m) => m.provider === p.id);
          if (!ms.length) return null;
          return (
            <section key={p.id} className="group" aria-labelledby={`mg-${p.id}`}>
              <div className="group-head">
                <ProviderGlyph id={p.id} size={26} />
                <h2 id={`mg-${p.id}`}>{p.name}</h2>
                <span className="group-count">{ms.length}</span>
              </div>
              <ul className="inset-list models">
                {ms.map((m) => (
                  <ModelRow key={m.slug} m={m} />
                ))}
              </ul>
            </section>
          );
        })
      )}

      {hidden.length > 0 && (
        <details className="hidden-models">
          <summary>
            <IconChevron size={12} className="disclosure" /> Ẩn <span className="group-count">{hidden.length}</span>
            <span className="dim small"> Model có trong danh mục nhưng không hiện trong bộ chọn của Codex</span>
          </summary>
          <ul className="inset-list models">
            {hidden.map((m) => (
              <ModelRow key={m.slug} m={m} />
            ))}
          </ul>
        </details>
      )}

      <Sheet
        open={confirmUnsync}
        onClose={() => setConfirmUnsync(false)}
        title="Gỡ đồng bộ khỏi Codex?"
        width={440}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmUnsync(false)} data-autofocus>
              Huỷ
            </Button>
            <Button variant="danger" busy={unsyncing} onClick={unsync}>
              Gỡ đồng bộ
            </Button>
          </>
        }
      >
        <p className="confirm-text">
          Code Hole sẽ xoá phần cấu hình nó đã thêm vào <span className="mono">config.toml</span> của Codex. Codex sẽ quay lại dùng nhà cung cấp mặc định
          sau khi khởi động lại.
        </p>
      </Sheet>
    </div>
  );
}
