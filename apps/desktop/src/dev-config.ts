import { DEFAULT_STELLA_DESKTOP_BRIDGE_PORT } from "./shared/rpc";

const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_DESKTOP_VIEW_PORT = 5177;

const parsePort = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return fallback;
  }

  return parsed;
};

const parseOrigins = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

const resolveWebPort = (env: NodeJS.ProcessEnv = process.env) =>
  parsePort(env.STELLA_WEB_PORT, DEFAULT_WEB_PORT);

export const resolveDesktopBridgePort = (
  env: NodeJS.ProcessEnv = process.env,
) =>
  parsePort(env.STELLA_DESKTOP_BRIDGE_PORT, DEFAULT_STELLA_DESKTOP_BRIDGE_PORT);

export const resolveDesktopViewPort = (env: NodeJS.ProcessEnv = process.env) =>
  parsePort(env.STELLA_DESKTOP_VIEW_PORT, DEFAULT_DESKTOP_VIEW_PORT);

export const resolveDesktopAllowedOrigins = (
  env: NodeJS.ProcessEnv = process.env,
) => {
  const webPort = resolveWebPort(env);

  return new Set([
    `http://127.0.0.1:${String(webPort)}`,
    `http://localhost:${String(webPort)}`,
    ...parseOrigins(env.STELLA_DESKTOP_ALLOWED_ORIGINS),
  ]);
};
