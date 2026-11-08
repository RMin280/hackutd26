// Display text for reasons and titles. Same labels as frontend/src/mock/site.ts so
// the decision feed reads the same whether the mock or the backend produced it.
// No Intl / toLocaleString: the module runtime should not depend on ICU.

export function label(id: string): string {
  let m: RegExpMatchArray | null;
  if ((m = id.match(/^cdu-(\d+)$/))) return `CDU-${m[1]}`;
  if ((m = id.match(/^pdu-r(\d+)-([ab])$/))) return `PDU-R${m[1]}-${m[2].toUpperCase()}`;
  if ((m = id.match(/^ups-([ab])$/))) return `UPS-${m[1].toUpperCase()}`;
  if ((m = id.match(/^switchgear-([ab])$/))) return `Switchgear ${m[1].toUpperCase()}`;
  if ((m = id.match(/^util-([ab])$/))) return `Utility ${m[1].toUpperCase()}`;
  if ((m = id.match(/^chiller-(\d+)$/))) return `Chiller ${m[1]}`;
  if ((m = id.match(/^sw-leaf-r(\d+)$/))) return `Leaf R${m[1]}`;
  if ((m = id.match(/^sw-spine-(\d+)$/))) return `Spine ${m[1]}`;
  if ((m = id.match(/^ha-(\d+)$/))) return `Hot aisle ${m[1]}`;
  if ((m = id.match(/^row-(\d+)$/))) return `Row ${m[1]}`;
  return id;
}

/** 1000 -> "1,000" */
export function fmtInt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** Simulated minutes -> "T+10m", "T+4h", "T+72h13m" (same as the frontend clock). */
export function clock(min: number): string {
  if (min < 60) return `T+${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `T+${h}h${m}m` : `T+${h}h`;
}

export function duration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export function formatRows(rows: number[]): string {
  const u = [...new Set(rows)].sort((a, b) => a - b);
  if (u.length === 0) return 'no rows';
  if (u.length === 1) return `Row ${u[0]}`;
  const contiguous = u.every((r, i) => i === 0 || r === u[i - 1] + 1);
  return contiguous ? `Rows ${u[0]}–${u[u.length - 1]}` : `Rows ${u.join(', ')}`;
}

export function formatList(ids: string[], max = 3): string {
  const u = [...new Set(ids)];
  if (u.length <= max) return u.map(label).join(', ');
  return `${label(u[0])} … ${label(u[u.length - 1])}`;
}

export function joinAnd(items: string[]): string {
  const u = [...new Set(items)];
  if (u.length <= 1) return u.join('');
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
