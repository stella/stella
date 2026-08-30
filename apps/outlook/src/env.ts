const DEV_DEFAULTS = {
  apiBaseUrl: "/api",
  stellaWebUrl: "http://localhost:3000",
  taskpaneOrigin: "https://localhost:3002",
} as const;

const PROD_DEFAULTS = {
  apiBaseUrl: "https://api.stll.app",
  stellaWebUrl: "https://my.stll.app",
  taskpaneOrigin: "https://outlook.stll.app",
} as const;

declare global {
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

export const env = {
  apiBaseUrl: readBuildString(
    globalThis.STELLA_API_ORIGIN,
    defaults.apiBaseUrl,
  ),
  buildEnvironment: BUILD_ENV,
  releaseVersion: readBuildString(globalThis.STELLA_OUTLOOK_VERSION, "0.0.0.0"),
  signInOrigin: readBuildString(
    globalThis.STELLA_WEB_ORIGIN,
    defaults.stellaWebUrl,
  ),
  stellaWebUrl: readBuildString(
    globalThis.STELLA_WEB_ORIGIN,
    defaults.stellaWebUrl,
  ),
  taskpaneOrigin: readBuildString(
    globalThis.STELLA_TASKPANE_ORIGIN,
    defaults.taskpaneOrigin,
  ),
};
