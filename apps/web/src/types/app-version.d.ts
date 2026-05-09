/**
 * Build-time constant injected by `vite.config.ts` from the
 * repo-root `VERSION` file. Available everywhere in the web app
 * (no `VITE_` prefix because it's a literal substitution, not an
 * env var that callers can override at runtime).
 */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT_SHA__: string;
