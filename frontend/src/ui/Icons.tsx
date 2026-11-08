import type { ReactNode } from 'react';

// Icons only where they label a control. 16px grid, 1.75px stroke, square caps to match NMC²'s square corners.
const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="square" strokeLinejoin="miter" aria-hidden>
    {children}
  </svg>
);

export const IconPlay = () => (
  <Svg size={14}>
    <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPause = () => (
  <Svg size={14}>
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconNext = () => (
  <Svg size={14}>
    <path d="M6 5v14l9-7z" fill="currentColor" stroke="none" />
    <path d="M18 5v14" />
  </Svg>
);
export const IconReset = () => (
  <Svg size={14}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v4h4" />
  </Svg>
);
export const IconClose = () => (
  <Svg size={14}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconTarget = () => (
  <Svg size={14}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
export function IconChevron({ dir }: { dir: 'left' | 'right' | 'up' | 'down' }) {
  const d = { left: 'M14.5 6 8.5 12l6 6', right: 'M9.5 6l6 6-6 6', up: 'M6 14.5l6-6 6 6', down: 'M6 9.5l6 6 6-6' }[dir];
  return (
    <Svg size={14}>
      <path d={d} />
    </Svg>
  );
}

// The work board's trade glyphs: what kind of hands a piece of work needs, readable before the words.
export const IconChip = () => (
  <Svg>
    <rect x="7" y="7" width="10" height="10" />
    <path d="M10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" />
  </Svg>
);
export const IconFan = () => (
  <Svg>
    <circle cx="12" cy="12" r="2" />
    <path d="M12 10c0-4 2-7 5-7 1 3-1 6-5 7zM14 12c4 0 7 2 7 5-3 1-6-1-7-5zM12 14c0 4-2 7-5 7-1-3 1-6 5-7zM10 12c-4 0-7-2-7-5 3-1 6 1 7 5z" />
  </Svg>
);
export const IconBolt = () => (
  <Svg>
    <path d="M13 3 5 14h6l-1 7 8-11h-6z" />
  </Svg>
);
export const IconNetwork = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="5" />
    <rect x="3" y="16" width="6" height="5" />
    <rect x="15" y="16" width="6" height="5" />
    <path d="M12 8v4M12 12H6v4M12 12h6v4" />
  </Svg>
);
export const IconGear = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Svg>
);
export const IconLock = () => (
  <Svg size={12}>
    <rect x="5" y="11" width="14" height="10" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
export const IconPerson = () => (
  <Svg size={14}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
  </Svg>
);
export const IconBot = () => (
  <Svg size={14}>
    <rect x="5" y="8" width="14" height="11" />
    <path d="M12 4v4M9 13h.01M15 13h.01M2 13h3M19 13h3" />
  </Svg>
);
