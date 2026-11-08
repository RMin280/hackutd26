// The one piece of navigation: Hall or Work board. It sits in the same place on both screens
// (left end of the top bar) so the switch is never something to hunt for; B does the same.
// A board opened on its own (?view=work) has nowhere else to go, so it shows nothing.

import { boardOnly, useStore, type ViewName } from '../store';

const TABS: { view: ViewName; label: string; hint: string }[] = [
  { view: 'hall', label: 'Hall', hint: 'The 3D hall and the decision feed' },
  { view: 'board', label: 'Work board', hint: 'What the floor sees: every piece of work, who has it, what it needs' },
];

export function ViewTabs() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  if (boardOnly) return null;
  return (
    <nav className="view-tabs" aria-label="View">
      {TABS.map((t) => (
        <button key={t.view} role="tab" aria-selected={view === t.view} className={view === t.view ? 'on' : ''} onClick={() => setView(t.view)} title={`${t.hint} (B switches)`}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
