// SF-Symbols-like line icons (1.6px stroke, rounded joins), drawn on a 24px grid.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconGauge = (p: P) => (
  <Base {...p}>
    <path d="M4.2 17.5a9 9 0 1 1 15.6 0" />
    <path d="M12 13.2 15.6 8.6" />
    <circle cx="12" cy="13.6" r="1.4" fill="currentColor" stroke="none" />
  </Base>
);
export const IconPeople = (p: P) => (
  <Base {...p}>
    <circle cx="9" cy="8.5" r="3.3" />
    <path d="M3 19.2c.6-3.2 3-5 6-5s5.4 1.8 6 5" />
    <path d="M15.4 5.6a3 3 0 0 1 0 5.8" />
    <path d="M17.6 14.6c1.7.6 2.9 2 3.3 4.4" />
  </Base>
);
export const IconCube = (p: P) => (
  <Base {...p}>
    <path d="M12 2.9 20 7.3v9.4l-8 4.4-8-4.4V7.3z" />
    <path d="M4.2 7.4 12 11.8l7.8-4.4" />
    <path d="M12 11.8v9.1" />
  </Base>
);
export const IconList = (p: P) => (
  <Base {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.6" cy="6.5" r=".9" fill="currentColor" />
    <circle cx="4.6" cy="12" r=".9" fill="currentColor" />
    <circle cx="4.6" cy="17.5" r=".9" fill="currentColor" />
  </Base>
);
export const IconPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const IconMinus = (p: P) => (
  <Base {...p}>
    <path d="M5 12h14" />
  </Base>
);
export const IconRefresh = (p: P) => (
  <Base {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.6 4.2v4.3h-4.3" />
  </Base>
);
export const IconTrash = (p: P) => (
  <Base {...p}>
    <path d="M4.5 6.8h15" />
    <path d="M9.3 6.6V4.9c0-.6.5-1 1-1h3.4c.6 0 1 .4 1 1v1.7" />
    <path d="m6.4 6.8.9 12.2c.1 1 .9 1.8 1.9 1.8h5.6c1 0 1.8-.8 1.9-1.8l.9-12.2" />
  </Base>
);
export const IconClose = (p: P) => (
  <Base {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Base>
);
export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Base>
);
export const IconCheckCircle = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.2 12.3 2.6 2.6 5-5.3" />
  </Base>
);
export const IconWarn = (p: P) => (
  <Base {...p}>
    <path d="M10.3 4.3 2.9 17.4A2 2 0 0 0 4.6 20.4h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4.2" />
    <circle cx="12" cy="16.9" r=".6" fill="currentColor" />
  </Base>
);
export const IconInfo = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.2" />
    <circle cx="12" cy="7.9" r=".6" fill="currentColor" />
  </Base>
);
export const IconHourglass = (p: P) => (
  <Base {...p}>
    <path d="M6.5 3.5h11M6.5 20.5h11" />
    <path d="M7.5 3.5c0 4.6 4.5 5.6 4.5 8.5S7.5 15.9 7.5 20.5M16.5 3.5c0 4.6-4.5 5.6-4.5 8.5s4.5 3.9 4.5 8.5" />
  </Base>
);
export const IconArrowSync = (p: P) => (
  <Base {...p}>
    <path d="M4.5 10a7.6 7.6 0 0 1 13.4-3.6L20 8.6" />
    <path d="M20 4.2v4.4h-4.4" />
    <path d="M19.5 14a7.6 7.6 0 0 1-13.4 3.6L4 15.4" />
    <path d="M4 19.8v-4.4h4.4" />
  </Base>
);
export const IconArrowDownDoc = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5v11" />
    <path d="m7.6 10.3 4.4 4.4 4.4-4.4" />
    <path d="M4.5 15.5v2.6c0 1.3 1 2.4 2.4 2.4h10.2c1.3 0 2.4-1 2.4-2.4v-2.6" />
  </Base>
);
export const IconExternal = (p: P) => (
  <Base {...p}>
    <path d="M13.5 4.5h6v6" />
    <path d="M19.4 4.6 11 13" />
    <path d="M18.5 14v3.6c0 1.3-1 2.4-2.4 2.4H6.4A2.4 2.4 0 0 1 4 17.6V7.9c0-1.3 1-2.4 2.4-2.4H10" />
  </Base>
);
export const IconKey = (p: P) => (
  <Base {...p}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="m10.9 12.6 8.6-8.6M16.5 7l2.3 2.3M14.2 9.3l1.8 1.8" />
  </Base>
);
export const IconPerson = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.6 20c.8-3.8 3.8-6 7.4-6s6.6 2.2 7.4 6" />
  </Base>
);
export const IconPersonShare = (p: P) => (
  <Base {...p}>
    <circle cx="10" cy="8.5" r="3.5" />
    <path d="M3.4 19.6c.7-3.5 3.3-5.5 6.6-5.5 1.3 0 2.5.3 3.5.9" />
    <path d="M18.6 13.4v6.4M15.4 16.6h6.4" />
  </Base>
);
export const IconGlobe = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.4 9.2h17.2M3.4 14.8h17.2" />
    <path d="M12 3c2.3 2.4 3.4 5.4 3.4 9s-1.1 6.6-3.4 9c-2.3-2.4-3.4-5.4-3.4-9S9.7 5.4 12 3z" />
  </Base>
);
export const IconBolt = (p: P) => (
  <Base {...p}>
    <path d="M13.2 2.8 5.3 13.4h6.1l-1 7.8 7.9-10.6h-6.1z" />
  </Base>
);
export const IconChevron = (p: P) => (
  <Base {...p}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </Base>
);
export const IconPhoto = (p: P) => (
  <Base {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.6" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 4.8-4.4 3.4 3 3.3-2.8L20.4 17" />
  </Base>
);
export const IconBrain = (p: P) => (
  <Base {...p}>
    <path d="M9.2 4.2a3 3 0 0 0-3 3 3 3 0 0 0-1.9 5.2 3.2 3.2 0 0 0 2.3 5.3A3 3 0 0 0 12 19V5.9a2.2 2.2 0 0 0-2.8-1.7z" />
    <path d="M14.8 4.2a3 3 0 0 1 3 3 3 3 0 0 1 1.9 5.2 3.2 3.2 0 0 1-2.3 5.3A3 3 0 0 1 12 19" />
  </Base>
);
export const IconDoc = (p: P) => (
  <Base {...p}>
    <path d="M6.5 3.5h7.4l4.6 4.6v10.8c0 .9-.7 1.6-1.6 1.6h-10.4c-.9 0-1.6-.7-1.6-1.6V5.1c0-.9.7-1.6 1.6-1.6z" />
    <path d="M13.5 3.8v4.6h4.7" />
    <path d="M8.5 13h7M8.5 16.4h5" />
  </Base>
);
export const IconTerminal = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </Base>
);
export const IconImport = (p: P) => (
  <Base {...p}>
    <path d="M9 4.5H6.8c-1.3 0-2.3 1-2.3 2.3v10.4c0 1.3 1 2.3 2.3 2.3h10.4c1.3 0 2.3-1 2.3-2.3V15" />
    <path d="M20 4 11 13" />
    <path d="M11 7.8V13h5.2" />
  </Base>
);
export const IconClock = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.3 2" />
  </Base>
);
export const IconUnlink = (p: P) => (
  <Base {...p}>
    <path d="M9.6 14.4 7.4 16.6a3.3 3.3 0 0 1-4.7-4.7l2.2-2.2" />
    <path d="m14.4 9.6 2.2-2.2a3.3 3.3 0 0 1 4.7 4.7l-2.2 2.2" />
    <path d="M4 4l16 16" />
  </Base>
);
export const IconCopy = (p: P) => (
  <Base {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.4" />
    <path d="M15.5 8.5V6.4c0-1.3-1-2.4-2.4-2.4H6.4C5.1 4 4 5.1 4 6.4v6.7c0 1.3 1.1 2.4 2.4 2.4h2.1" />
  </Base>
);

export function AppGlyph({ size = 30 }: { size?: number }) {
  // A "hole": concentric rings with a soft gradient core.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="ch-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5AC8FA" />
          <stop offset=".55" stopColor="#0A84FF" />
          <stop offset="1" stopColor="#5E5CE6" />
        </linearGradient>
        <radialGradient id="ch-core" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#05070d" />
          <stop offset=".7" stopColor="#0b1530" />
          <stop offset="1" stopColor="#0b1530" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#ch-g)" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="6.6" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="4.6" fill="url(#ch-core)" />
    </svg>
  );
}

export const IconChartBar = (p: P) => (
  <Base {...p}>
    <path d="M4.5 19.5V12" />
    <path d="M10 19.5V5" />
    <path d="M15.5 19.5v-9" />
    <path d="M21 19.5V8" />
    <path d="M3 19.5h18" />
  </Base>
);

export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Base>
);

export const IconDownload = (p: P) => (
  <Base {...p}>
    <path d="M12 4v11" />
    <path d="m7.5 11 4.5 4.5 4.5-4.5" />
    <path d="M5 19.5h14" />
  </Base>
);
