import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/api.ts";
import { useHashRoute, usePoll } from "./lib/hooks.ts";
import { ToastProvider } from "./components/ui.tsx";
import { AppGlyph, IconCube, IconGauge, IconList, IconPeople } from "./components/icons.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { AccountsPage } from "./pages/accounts.tsx";
import { ModelsPage } from "./pages/models.tsx";
import { ActivityPage } from "./pages/activity.tsx";

const ROUTES = ["overview", "accounts", "models", "activity"] as const;
type Route = (typeof ROUTES)[number];

const NAV: Array<{ id: Route; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "Tổng quan", icon: <IconGauge size={17} /> },
  { id: "accounts", label: "Tài khoản", icon: <IconPeople size={17} /> },
  { id: "models", label: "Models", icon: <IconCube size={17} /> },
  { id: "activity", label: "Nhật ký", icon: <IconList size={17} /> },
];

function App() {
  const [route, go] = useHashRoute(ROUTES, "overview");
  const status = usePoll(() => api.status(), 10_000);
  const accounts = usePoll(() => api.accounts(), 10_000);
  const [statusAt, setStatusAt] = useState(Date.now());
  useEffect(() => setStatusAt(Date.now()), [status.data]);

  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const label = NAV.find((n) => n.id === route)?.label ?? "";
    document.title = `${label} · Code Hole`;
  }, [route]);

  const online = !!status.data && !status.error;
  const attention = (accounts.data ?? []).filter((a) => a.status !== "ok").length;

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Chuyển tới nội dung
      </a>
      <aside className="sidebar" aria-label="Điều hướng">
        <div className="brand">
          <AppGlyph size={30} />
          <div className="brand-text">
            <div className="brand-name">Code Hole</div>
            <div className="brand-sub">Proxy cho Codex</div>
          </div>
        </div>
        <nav>
          <ul>
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#/${n.id}`}
                  className={`nav-item ${route === n.id ? "active" : ""}`}
                  title={n.label}
                  aria-current={route === n.id ? "page" : undefined}
                >
                  <span className="nav-icon">{n.icon}</span>
                  <span className="nav-label">{n.label}</span>
                  {n.id === "accounts" && attention > 0 && (
                    <span className="nav-badge" aria-label={`${attention} tài khoản cần chú ý`}>
                      {attention}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-foot">
          <span className={`status-dot ${online ? "on" : status.data || status.error ? "off" : ""}`} aria-hidden="true" />
          <span className="nav-label">{online ? `Đang chạy · cổng ${status.data!.port}` : status.error ? "Mất kết nối" : "Đang kết nối…"}</span>
        </div>
      </aside>
      <main id="main" className="main" ref={mainRef} tabIndex={-1}>
        <div key={route} className="route">
          {route === "overview" && (
            <OverviewPage status={status.data} statusAt={statusAt} statusError={status.error} accounts={accounts.data} go={go} />
          )}
          {route === "accounts" && (
            <AccountsPage
              accounts={accounts.data}
              error={accounts.error}
              loading={accounts.loading}
              reload={async () => {
                await Promise.all([accounts.reload(), status.reload()]);
              }}
              mutate={accounts.mutate}
            />
          )}
          {route === "models" && <ModelsPage />}
          {route === "activity" && <ActivityPage />}
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
