import { buildVersionedApiUrl, MCP_APP_SANDBOX_PATH } from "@stll/api-contract";

import {
  browserApiBaseUrl,
  browserApiRootUrl,
  browserAuthBaseUrl,
  externalApiOrigin,
} from "@/lib/api-origins";

/**
 * Builds an absolute URL for a versioned (`/v1`) API route.
 *
 * The Eden treaty client (`@/lib/api`) is the typed default and should be
 * used wherever possible: it checks routes against the backend at compile
 * time. Direct `fetch()` is reserved for streaming, SSE, binary downloads,
 * and isolated runtime-validated routes intentionally excluded from Eden's
 * recursive web type surface; those calls must still route through here so
 * the API origin and the `/v1` version prefix have a single home.
 *
 * Browser calls intentionally resolve through the web origin's `/api` edge
 * mount; direct external URLs remain available through externalApiUrl().
 */
export const externalApiUrl = (path: `/${string}`): string =>
  buildVersionedApiUrl(externalApiOrigin(), path);

export const browserApiUrl = (path: `/${string}`): string =>
  buildVersionedApiUrl(browserApiBaseUrl(), path);

/** Browser API URL used by the app's REST, stream, and download calls. */
export const apiUrl = (path: `/${string}`): string => browserApiUrl(path);

/** Better Auth expects the origin and appends `/api/auth` itself. */
export const mcpAppSandboxUrl = (): URL =>
  new URL(browserApiRootUrl(MCP_APP_SANDBOX_PATH));

export {
  browserApiBaseUrl,
  browserApiRootUrl,
  browserAuthBaseUrl,
} from "@/lib/api-origins";
