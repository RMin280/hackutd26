import { useMemo } from 'react';
import { useStore } from '../store';

/** Racks under an active protection lease right now. */
export function useProtectedRacks() {
  const leases = useStore((s) => s.world.leases);
  const now = useStore((s) => s.world.now);
  return useMemo(
    () =>
      new Set(leases.filter((l) => l.type === 'protection' && l.start <= now && now < l.end).flatMap((l) => l.racks ?? [])),
    [leases, now],
  );
}

/** Parts that are the only working feed for at least one rack. */
export function useUnprotectedParts() {
  const world = useStore((s) => s.world);
  return useMemo(() => {
    const set = new Set<string>();
    for (const m of Object.values(world.margins)) for (const p of m.unprotected) set.add(p);
    return set;
  }, [world.margins]);
}

