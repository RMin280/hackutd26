// Live mode is on when VITE_SPACETIMEDB_URI is set (e.g. in frontend/.env.local).
// Without it the view runs on the built-in mock, as before.

const env = import.meta.env;

export const LIVE_URI: string | undefined = env.VITE_SPACETIMEDB_URI || undefined;
export const LIVE_DB: string = env.VITE_SPACETIMEDB_DB || 'squawk';
export const liveEnabled = Boolean(LIVE_URI);
