import { useMemo } from 'react';
import { useStore } from '../store';

/** Parts that are the only working feed for at least one rack. */
export function useUnprotectedParts() {
  const world = useStore((s) => s.world);
  return useMemo(() => {
    const set = new Set<string>();
    for (const m of Object.values(world.margins)) for (const p of m.unprotected) set.add(p);
    return set;
  }, [world.margins]);
}

