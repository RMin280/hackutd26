import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import './styles.css';
import App from './App';

// No StrictMode: it double-runs effects in dev, which would double-step autoplay.
createRoot(document.getElementById('root')!).render(<App />);

// Live mode (VITE_SPACETIMEDB_URI set, see .env.example): the SpacetimeDB backend feeds the view.
if (import.meta.env.VITE_SPACETIMEDB_URI) void import('./live/connection').then((m) => m.startLive());
