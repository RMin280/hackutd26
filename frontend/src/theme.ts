// Scene palette, from NMC²'s brand: black, azure #2b9cfc, deep blue #0066cc,
// pale blue #c0d1f1 and sand gold #ddb67c. Red is the one non-brand colour,
// kept for failures. Healthy equipment stays neutral; colour means "look here".

export const C = {
  bg: '#050505',
  hallFloor: '#161618',
  tileLine: '#212124',
  coldAisle: '#0c131c',
  coldDot: '#132131',
  hotAisle: '#15120d',
  hotGlass: '#ddb67c',
  hotFrame: '#6f5a3c',
  label: '#77777c',
  hotLabel: '#a58b62',

  rackBody: '#2a2a2d',
  rackBodyHover: '#3a3a3e',
  rackBodyLit: '#343438',
  rackBodyDim: '#1c1c1e',
  stripOk: '#123d63',
  // lid on a rack under a protection lease: azure toned down so 128 of them don't shout
  lidProtected: '#2a6fae',

  azure: '#2b9cfc',
  blue: '#0066cc',
  ice: '#c0d1f1',
  gold: '#ddb67c',
  red: '#e5534b',
  white: '#f5f5f5',

  // node panels
  nodeJob: '#1d3b5e',
  nodeTenant: '#2c2c30',
  nodeFree: '#1a1a1c',

  // equipment
  partBody: '#232326',
  partBodyHover: '#323236',
  partCap: '#3b3b40',
};

export const STATE_COLOR: Record<string, string> = {
  ok: C.partCap,
  degraded: C.gold,
  failed: C.red,
  maintenance: C.ice,
};
