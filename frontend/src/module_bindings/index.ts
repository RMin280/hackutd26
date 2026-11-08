// Placeholder so the app builds before the SpacetimeDB bindings exist.
// `npm run bindings` replaces this folder with code generated from ../spacetimedb
// (`spacetime generate`). Only live mode (VITE_SPACETIMEDB_URI set) touches it.

const missing = () => {
  throw new Error('SpacetimeDB bindings are not generated yet: run `npm run bindings` in frontend/, then restart `npm run dev`.');
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DbConnection: any = { builder: missing };
