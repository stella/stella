import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

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
  apiBaseUrl: string;
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

const PLACEHOLDER_KEYS = [
  "API_ORIGIN",
  "PROVIDER_NAME",
  "SUPPORT_URL",
  "TASKPANE_ORIGIN",
  "VERSION",
  "WEB_ORIGIN",
] as const satisfies readonly (keyof ManifestPlaceholders)[];

export const resolveManifestPlaceholders = (
  env: ManifestEnv,
  runtimeEnv: Record<string, string | undefined> = process.env,
): ManifestPlaceholders => {
  const defaults = PLACEHOLDER_DEFAULTS[env];
  const result = { ...defaults };
  for (const key of PLACEHOLDER_KEYS) {
    const override = runtimeEnv[PLACEHOLDER_ENV_VARS[key]];
    if (override) {
      result[key] = override;
    }
  }
  return result;
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
  apiBaseUrl:
    env === "dev" && !runtimeEnv["STELLA_API_ORIGIN"]
      ? "/api"
      : placeholders.API_ORIGIN,
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
