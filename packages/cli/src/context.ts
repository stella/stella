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
   * The default org's stored access token for `serverUrl`, if signed in.
   * Not proactively refreshed here — a Phase 3+ HTTP client wrapper should
   * call `auth/ensure-fresh-credential.ts` reactively on a 401, matching
   * `stella auth whoami`'s "no extra server calls unless needed" stance.
   */
  readonly token: string | undefined;
};
