import { buildVersionedApiUrl, MCP_APP_SANDBOX_PATH } from "@stll/api-contract";
import { VISUAL_SANDBOX_PATH } from "@stll/api-contract/visual-sandbox";

import {
  browserApiBaseUrl,
  browserApiRootUrl,
  externalApiOrigin,
} from "@/lib/api-origins";

/** Browser API URL used by the app's REST, stream, and download calls. */
export const apiUrl = (path: `/${string}`): string =>
  buildVersionedApiUrl(browserApiBaseUrl(), path);

/** The two API bases a deployment configures (`@/lib/api-origins`). */
type ApiDeployment = {
  /** The public API. */
  publicApiUrl: string;
  /** What the browser calls: the web app's own `/api` mount, when set. */
  browserApiUrl: string;
};

/**
 * Where an MCP App's sandbox proxy is served: the public API origin. The
 * proxy and the page that frames it must be different origins (the sandbox
 * document and the chat host both refuse a shared one), and the browser API
 * mount always shares the web app's origin (`browserApiInvariantViolation`),
 * so the mount can never serve this sandbox. The browser base is an argument
 * only so a test can hold that it is never the answer.
 */
export const mcpAppSandboxUrlIn = ({ publicApiUrl }: ApiDeployment): URL =>
  new URL(MCP_APP_SANDBOX_PATH, publicApiUrl);

export const mcpAppSandboxUrl = (): URL =>
  mcpAppSandboxUrlIn({
    publicApiUrl: externalApiOrigin(),
    browserApiUrl: browserApiBaseUrl(),
  });

/** A generated visual's frame shell, which isolates itself on any origin. */
export const visualSandboxUrl = (): URL =>
  new URL(browserApiRootUrl(VISUAL_SANDBOX_PATH));

/** Every sandbox document the app frames: the page policy's `frame-src`. */
export const frameSandboxUrls = (): readonly string[] => [
  visualSandboxUrl().href,
  mcpAppSandboxUrl().href,
];

export {
  browserApiBaseUrl,
  browserApiRootUrl,
  browserAuthBaseUrl,
} from "@/lib/api-origins";
