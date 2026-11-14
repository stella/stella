// Build-time configuration. `scripts/build.ts` defines each global; a test or
// a browser preview without them gets the development defaults.

const DEV_DEFAULTS = {
  apiFetchBase: "/api",
  apiOrigin: "http://localhost:3001",
  taskpaneOrigin: "https://localhost:3002",
  webOrigin: "http://localhost:3000",
} as const;

const PROD_DEFAULTS = {
  apiFetchBase: "https://api.stll.app",
  apiOrigin: "https://api.stll.app",
  taskpaneOrigin: "https://outlook.stll.app",
  webOrigin: "https://my.stll.app",
} as const;

declare global {
  var STELLA_API_FETCH_BASE: string | undefined;
  var STELLA_API_ORIGIN: string | undefined;
  var STELLA_BUILD_ENV: string | undefined;
  var STELLA_OUTLOOK_VERSION: string | undefined;
  var STELLA_TASKPANE_ORIGIN: string | undefined;
  var STELLA_WEB_ORIGIN: string | undefined;
}

const readBuildString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const BUILD_ENV = globalThis.STELLA_BUILD_ENV === "prod" ? "prod" : "dev";

const defaults = BUILD_ENV === "prod" ? PROD_DEFAULTS : DEV_DEFAULTS;

const stripTrailingSlash = (value: string): string => value.replace(/\/$/u, "");

export const env = {
  /**
   * Where the task pane sends requests meant for `apiOrigin`. The same origin
   * in production; the development server's `/api` proxy locally, because an
   * https task pane cannot call a plain-http local API.
   */
  apiFetchBase: stripTrailingSlash(
    readBuildString(globalThis.STELLA_API_FETCH_BASE, defaults.apiFetchBase),
  ),
  /** The API's public origin: the OAuth resource and authorization server. */
  apiOrigin: new URL(
    readBuildString(globalThis.STELLA_API_ORIGIN, defaults.apiOrigin),
  ).origin,
  buildEnvironment: BUILD_ENV,
  releaseVersion: readBuildString(globalThis.STELLA_OUTLOOK_VERSION, "0.0.0.0"),
  taskpaneOrigin: new URL(
    readBuildString(globalThis.STELLA_TASKPANE_ORIGIN, defaults.taskpaneOrigin),
  ).origin,
  webOrigin: new URL(
    readBuildString(globalThis.STELLA_WEB_ORIGIN, defaults.webOrigin),
  ).origin,
};

/**
 * The address the task pane fetches for a URL on the API origin: unchanged
 * when it calls the API directly, routed through the development proxy
 * otherwise. URLs on any other origin are returned as they are.
 */
export const apiFetchUrl = (
  url: string,
  config: Pick<typeof env, "apiFetchBase" | "apiOrigin"> = env,
): string => {
  if (config.apiFetchBase === config.apiOrigin) {
    return url;
  }
  const parsed = URL.parse(url);
  if (parsed?.origin !== config.apiOrigin) {
    return url;
  }
  return `${config.apiFetchBase}${parsed.pathname}${parsed.search}`;
};
