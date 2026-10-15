import { buildVersionedApiUrl, MCP_APP_SANDBOX_PATH } from "@stll/api-contract";

import { browserApiBaseUrl, browserApiRootUrl } from "@/lib/api-origins";

/** Browser API URL used by the app's REST, stream, and download calls. */
export const apiUrl = (path: `/${string}`): string =>
  buildVersionedApiUrl(browserApiBaseUrl(), path);

/** Better Auth expects the origin and appends `/api/auth` itself. */
export const mcpAppSandboxUrl = (): URL =>
  new URL(browserApiRootUrl(MCP_APP_SANDBOX_PATH));

export {
  browserApiBaseUrl,
  browserApiRootUrl,
  browserAuthBaseUrl,
} from "@/lib/api-origins";
