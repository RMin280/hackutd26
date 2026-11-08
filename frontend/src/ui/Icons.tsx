import type { ReactNode } from 'react';

const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const IconMap = () => (
  <Svg>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Svg>
);
export const IconPlay = () => (
  <Svg>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPause = () => (
  <Svg>
    <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconNext = () => (
  <Svg>
    <path d="M5 4.5v15l10-7.5z" fill="currentColor" stroke="none" />
    <path d="M19 5v14" />
  </Svg>
);
export const IconReset = () => (
  <Svg>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);
export const IconLock = () => (
  <Svg>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
export const IconServer = () => (
  <Svg>
    <rect x="4" y="3" width="16" height="7" rx="1.5" />
    <rect x="4" y="14" width="16" height="7" rx="1.5" />
    <path d="M8 6.5h.01M8 17.5h.01" />
  </Svg>
);
export const IconCpu = () => (
  <Svg>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Svg>
);
export const IconSnow = () => (
  <Svg>
    <path d="M12 2v20M4.9 6l14.2 12M19.1 6 4.9 18" />
  </Svg>
);
export const IconBolt = () => (
  <Svg>
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
  </Svg>
);
export const IconNetwork = () => (
  <Svg>
    <rect x="9" y="2" width="6" height="6" rx="1" />
    <rect x="2" y="16" width="6" height="6" rx="1" />
    <rect x="16" y="16" width="6" height="6" rx="1" />
    <path d="M12 8v4M5 16v-4h14v4" />
  </Svg>
);
export const IconShield = () => (
  <Svg>
    <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);
export const IconCalendar = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const IconChevron = () => (
  <Svg size={14}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconTarget = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const IconAlert = () => (
  <Svg>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
export const IconBriefcase = () => (
  <Svg>
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
  </Svg>
);
export const IconLogo = () => (
  <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
    <circle cx="16" cy="16" r="14" fill="none" stroke="#4c8dff" strokeWidth="2.5" opacity="0.35" />
    <circle cx="16" cy="16" r="9" fill="none" stroke="#4c8dff" strokeWidth="2.5" opacity="0.7" />
    <circle cx="16" cy="16" r="4" fill="#4c8dff" />
  </svg>
);
