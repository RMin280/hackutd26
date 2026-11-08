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
