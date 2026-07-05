// Shared stricli application context (spec 051 S5.1): a single `Context` type
// threaded through every command. Auth resolution, the real server client, and
// scope prechecks are out of scope for this phase; this is the minimal typed
// sketch a later phase fills in.

import type { CommandContext } from "@stricli/core";

/** Context every generated (and hand-written) command receives. */
export type Context = CommandContext & {
  /** Resolved server origin the CLI is targeting (spec S5.5 provenance pin). */
  readonly serverUrl: string;
  /** Stored auth token for the current server origin, if any (auth: out of scope for this phase). */
  readonly token: string | undefined;
};
