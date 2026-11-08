// One palette for the 3D scene and the panels (mirrors the CSS variables in styles.css).
// Calm by default: healthy equipment stays graphite, colour means "look here".

export const C = {
  bg: '#0e0f12',
  ground: '#0f1013',
  hallFloor: '#1f2126',
  tileLine: '#2a2d33',
  coldAisle: '#1b222b',
  coldDot: '#28323e',
  hotAisle: '#2a1d19',
  hotGlass: '#ff8f57',
  hotFrame: '#6e4634',
  label: '#8a8f99',
  hotLabel: '#b06d4c',

  rackBody: '#30333a',
  rackBodyHover: '#434852',
  rackBodyLit: '#3c414a',
  rackBodyDim: '#1f2125',
  stripOk: '#2d6b52',

  text: '#f2f3f5',
  muted: '#8b8e95',

  blue: '#4c8dff',
  green: '#4ade80',
  amber: '#e5a83b',
  red: '#f06a6a',
  teal: '#2dd4bf',
  purple: '#8b7cf6',
  orange: '#e8743b',

  // node panels
  nodeJob: '#34486b',
  nodeTenant: '#35383f',
  nodeFree: '#24262b',

  // part bodies by group
  power: '#36322d',
  cooling: '#2b343d',
  network: '#322f45',
  partCap: '#454952',
};

export const STATE_COLOR: Record<string, string> = {
  ok: '#3a3d45',
  degraded: C.amber,
  failed: C.red,
  maintenance: C.purple,
};
