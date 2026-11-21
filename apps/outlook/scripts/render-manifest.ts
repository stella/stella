import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertOutlookReleaseVersion } from "./release-artifact";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const TEMPLATE_PATH = path.resolve(APP_ROOT, "manifest.template.xml");

export type ManifestEnv = "dev" | "prod";

export type ManifestPlaceholders = {
  API_ORIGIN: string;
  PROVIDER_NAME: string;
  SUPPORT_URL: string;
  TASKPANE_ORIGIN: string;
  VERSION: string;
  WEB_ORIGIN: string;
};

export type OutlookRuntimeConfig = {
  /** Where the task pane sends API requests: the development proxy locally. */
  apiFetchBase: string;
  apiOrigin: string;
  taskpaneOrigin: string;
  webOrigin: string;
};

const PLACEHOLDER_DEFAULTS: Record<ManifestEnv, ManifestPlaceholders> = {
  dev: {
    API_ORIGIN: "http://localhost:3001",
    PROVIDER_NAME: "stella (dev)",
    SUPPORT_URL: "https://stll.app",
    TASKPANE_ORIGIN: "https://localhost:3002",
    VERSION: "1.0.0.0",
    WEB_ORIGIN: "http://localhost:3000",
  },
  prod: {
    API_ORIGIN: "https://api.stll.app",
    PROVIDER_NAME: "stella",
    SUPPORT_URL: "https://stll.app",
    TASKPANE_ORIGIN: "https://outlook.stll.app",
    VERSION: "1.0.0.0",
    WEB_ORIGIN: "https://my.stll.app",
  },
};

const PLACEHOLDER_ENV_VARS: Record<keyof ManifestPlaceholders, string> = {
  API_ORIGIN: "STELLA_API_ORIGIN",
  PROVIDER_NAME: "STELLA_PROVIDER_NAME",
  SUPPORT_URL: "STELLA_SUPPORT_URL",
  TASKPANE_ORIGIN: "STELLA_TASKPANE_ORIGIN",
  VERSION: "STELLA_OUTLOOK_VERSION",
  WEB_ORIGIN: "STELLA_WEB_ORIGIN",
};

export const resolveManifestPlaceholders = (
  env: ManifestEnv,
  runtimeEnv: Record<string, string | undefined> = process.env,
): ManifestPlaceholders => {
  const defaults = PLACEHOLDER_DEFAULTS[env];
  const value = (key: keyof ManifestPlaceholders): string =>
    runtimeEnv[PLACEHOLDER_ENV_VARS[key]] || defaults[key];
  return {
    API_ORIGIN: value("API_ORIGIN"),
    PROVIDER_NAME: value("PROVIDER_NAME"),
    SUPPORT_URL: value("SUPPORT_URL"),
    TASKPANE_ORIGIN: value("TASKPANE_ORIGIN"),
    VERSION: value("VERSION"),
    WEB_ORIGIN: value("WEB_ORIGIN"),
  };
};

type ResolveOutlookRuntimeConfigOptions = {
  env: ManifestEnv;
  placeholders?: ManifestPlaceholders;
  runtimeEnv?: Record<string, string | undefined>;
};

export const resolveOutlookRuntimeConfig = ({
  env,
  runtimeEnv = process.env,
  placeholders = resolveManifestPlaceholders(env, runtimeEnv),
}: ResolveOutlookRuntimeConfigOptions): OutlookRuntimeConfig => ({
  // A local API is plain http, which an https task pane cannot call; the
  // development server proxies it under `/api` instead.
  apiFetchBase:
    env === "dev" && !runtimeEnv["STELLA_API_ORIGIN"]
      ? "/api"
      : placeholders.API_ORIGIN,
  apiOrigin: placeholders.API_ORIGIN,
  taskpaneOrigin: placeholders.TASKPANE_ORIGIN,
  webOrigin: placeholders.WEB_ORIGIN,
});

const UNRESOLVED_PATTERN = /\{\{[A-Z_]+\}\}/u;

export const renderManifest = (
  env: ManifestEnv,
  runtimeEnv: Record<string, string | undefined> = process.env,
): string => {
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const placeholders = resolveManifestPlaceholders(env, runtimeEnv);
  assertOutlookReleaseVersion(placeholders.VERSION);
  let output = template;
  for (const [key, value] of Object.entries(placeholders)) {
    output = output.replaceAll(`{{${key}}}`, () => value);
  }
  const unresolved = UNRESOLVED_PATTERN.exec(output);
  if (unresolved) {
    panic(`Unresolved manifest placeholder: ${unresolved[0]}`);
  }
  return output;
};
