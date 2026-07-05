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
