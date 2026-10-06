import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconCheckCircle, IconClose, IconInfo, IconMinus, IconPlus, IconWarn } from "./icons.tsx";
import { providerInfo } from "../lib/format.ts";

// ---------------------------------------------------------------- Toasts

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  leaving?: boolean;
}

const ToastCtx = createContext<(kind: ToastKind, title: string, detail?: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 260);
  }, []);
  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, kind, title, detail }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4200);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="region" aria-label="Thông báo" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}${t.leaving ? " leaving" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
            <span className="toast-icon">
              {t.kind === "success" ? <IconCheckCircle size={20} /> : t.kind === "error" ? <IconWarn size={20} /> : <IconInfo size={20} />}
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
            </div>
            <button className="icon-btn subtle" onClick={() => dismiss(t.id)} aria-label="Đóng thông báo">
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- Buttons & controls

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="11" y="2.5" width="2" height="5.5" rx="1" fill="currentColor" transform={`rotate(${i * 45} 12 12)`} opacity={0.25 + (i / 8) * 0.75} />
      ))}
    </svg>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "plain" | "danger" | "tinted";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = "secondary", size = "md", busy, icon, children, className = "", disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${busy ? "is-busy" : ""} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner size={size === "sm" ? 13 : 15} /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = (idx + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length;
      onChange(options[n]!.value);
      (e.currentTarget.querySelectorAll("button")[n] as HTMLButtonElement | undefined)?.focus();
    }
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKey} style={{ ["--n" as string]: options.length, ["--i" as string]: idx }}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, onChange, label, min = -99, max = 99 }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Giảm ${label.toLowerCase()}`}>
        <IconMinus size={13} />
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`Tăng ${label.toLowerCase()}`}>
        <IconPlus size={13} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Sheet (modal)

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    setTimeout(() => (el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, mounted]);

  if (!mounted) return null;
  // Portal to <body>: animated ancestors (transform) would otherwise trap position: fixed.
  return createPortal(
    <div className={`sheet-layer ${shown ? "shown" : ""}`}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} style={{ maxWidth: width }}>
        <header className="sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="sheet-sub">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Đóng">
            <IconClose size={15} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- Misc

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ProviderGlyph({ id, size = 32 }: { id: string; size?: number }) {
  const p = providerInfo(id);
  return (
    <span className="pglyph" style={{ ["--tint" as string]: p.tint, width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">
      {p.short}
    </span>
  );
}

export function Pill({ tone, children, title }: { tone: "green" | "red" | "orange" | "gray" | "blue"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Card({ children, className = "", ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {children && <div className="section-actions">{children}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", r = 8 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <IconWarn size={18} />
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" variant="plain" onClick={onRetry}>
          Thử lại
        </Button>
      )}
    </div>
  );
}
