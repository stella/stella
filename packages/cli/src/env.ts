// Centralizes every `process.env` read for `@stll/cli` (the
// `forbid-process-env-outside-env-ts` lint rule requires reads to live in an
// `env.ts`-named module; see `oxlint.config.ts`). Both variables are
// optional: the CLI never hard-requires an env var to start (self-hosting
// first-class — `--server`/`credentials.json` always work without either).

/** XDG base-directory override for `~/.config/stella`; see `auth/config-dir.ts`. */
export const XDG_CONFIG_HOME: string | undefined =
  process.env["XDG_CONFIG_HOME"];

/** Default `--server` origin when neither the flag nor a saved config exists; see `auth/server-resolution.ts`. */
export const STELLA_SERVER_URL: string | undefined =
  process.env["STELLA_SERVER_URL"];

/**
 * Machine (CI / agent) credential. When set, it is used verbatim as the bearer
 * token for every command and the stored `credentials.json` is not consulted at
 * all; see `auth/resolve-access-token.ts` for the precedence rationale.
 */
export const STELLA_API_KEY: string | undefined = process.env["STELLA_API_KEY"];

/** XDG cache base for the per-origin registry cache; see `registry-cache.ts`. */
export const XDG_CACHE_HOME: string | undefined = process.env["XDG_CACHE_HOME"];

/** Home directory, the `~/.cache` fallback root for the registry cache. */
export const HOME: string | undefined = process.env["HOME"];
