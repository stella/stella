// Shared stricli application context (spec 051 S5.1): a single `Context` type
// threaded through every command. Generated (Phase 3+) commands read
// `serverUrl`/`token` directly instead of re-resolving them; hand-written
// `stella auth` commands (this phase) resolve their own server/org from
// flags since they operate on a specific (possibly not-yet-configured)
// server rather than "the" current one.

import type { CommandContext } from "@stricli/core";

/** Context every generated (and hand-written) command receives. */
export type Context = CommandContext & {
  /**
   * Real Node/Bun process, not just stricli's minimal `WritableStreams`:
   * `stella auth login`'s manual-paste fallback needs `stdin`, and server
   * resolution reads `env`.
   */
  readonly process: NodeJS.Process;
  /** `~/.config/stella` (or `$XDG_CONFIG_HOME/stella`), resolved once per invocation. */
  readonly configDir: string;
  /** Resolved server origin (`--server`/env/config; see `auth/server-resolution.ts`), if any. */
  readonly serverUrl: string | undefined;
  /**
   * The default org's live access token for `serverUrl`, if signed in.
   * Resolved through `auth/resolve-access-token.ts`, which proactively
   * refreshes (and persists) an expired/near-expiry credential before the
   * command runs; `undefined` when there is no credential or a refresh failed,
   * in which case the command falls back to the "Not signed in" / exit-`auth`
   * path. A comfortably-valid credential is returned without any server call,
   * keeping startup offline-instant.
   */
  readonly token: string | undefined;
};
