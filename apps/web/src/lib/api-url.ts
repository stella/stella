import { env } from "@/env";

/**
 * Builds an absolute URL for a versioned (`/v1`) API route.
 *
 * The Eden treaty client (`@/lib/api`) is the typed default and should be
 * used wherever possible — it checks routes against the backend at compile
 * time. Direct `fetch()` is reserved for streaming, SSE, and binary
 * downloads that Eden cannot model; those calls must still route through
 * here so the API origin and the `/v1` version prefix have a single home.
 *
 * A hand-written relative path (e.g. `/api/...`) silently resolves against
 * the web origin and hits the SPA fallback (`200` + `index.html`) instead
 * of the API.
 */
export const apiUrl = (path: `/${string}`): string =>
  `${env.VITE_API_URL}/v1${path}`;
