// `--server` resolution: no hosted-SaaS URL is baked in (self-hosting is
// first-class; the CLI must not silently assume a build-time origin).
// Priority: `--server` flag > `STELLA_SERVER_URL` env var > the last server
// `stella auth login` succeeded against (`config.json#defaultServerUrl`).

import { Result } from "better-result";

import { STELLA_SERVER_URL } from "../env.js";
import { readCliConfig } from "./cli-config.js";
import { SERVER_URL_ENV_VAR } from "./constants.js";
import { ServerUrlNotConfiguredError } from "./errors.js";

const normalizeServerUrl = (input: string): string => input.replace(/\/$/u, "");

type ResolveServerUrlOptions = {
  readonly configDir: string;
  readonly flagValue: string | undefined;
  // The env tier is injected so a test owns it explicitly instead of
  // replacing the environment module for the whole process.
  readonly env?: { readonly STELLA_SERVER_URL: string | undefined };
};

export const resolveServerUrl = async ({
  configDir,
  flagValue,
  env = { STELLA_SERVER_URL },
}: ResolveServerUrlOptions): Promise<
  Result<string, ServerUrlNotConfiguredError>
> => {
  if (flagValue) {
    return Result.ok(normalizeServerUrl(flagValue));
  }

  if (env.STELLA_SERVER_URL) {
    return Result.ok(normalizeServerUrl(env.STELLA_SERVER_URL));
  }

  const config = await readCliConfig(configDir);
  if (config.defaultServerUrl) {
    return Result.ok(normalizeServerUrl(config.defaultServerUrl));
  }

  return Result.err(
    new ServerUrlNotConfiguredError({
      message: `No server configured. Pass --server <url>, set ${SERVER_URL_ENV_VAR}, or run \`stella auth login --server <url>\` once to set the default.`,
    }),
  );
};
