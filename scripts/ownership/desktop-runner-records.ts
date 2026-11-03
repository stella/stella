import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-runner-records",
  capability:
    "Reading and writing desktop runner sessions, runs, commands and events",
  owner: ["apps/api/src/lib/desktop-runner/store.ts"],
  summary:
    "Every write is conditional on the state it expects: a run's messages advance one position at a time, so the log has no hole and an `ack` follows only a stored message; commands are unique on their idempotency key; a lapsed lease moves a run to `waiting_for_computer` and never to another computer.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/desktop-runner"],
    names: [
      "desktopRunners",
      "desktopRunnerRuns",
      "desktopRunnerCommands",
      "desktopRunnerEvents",
    ],
    allowed: [
      {
        path: "apps/api/src/db/entity-feature-gate-repair.ts",
        reason:
          "Full-schema policy introspection: renders the entity feature policies the online cutover installs; reads no rows.",
      },
      {
        path: "apps/api/src/lib/member-assignment-offboarding.ts",
        reason:
          "Deletes the member's runners, and with them their runs, during organization membership removal.",
      },
      {
        path: "apps/api/src/lib/auth-artifacts.postgres.test.ts",
        reason:
          "Builds the runner table into its fixture schema, so member credential cleanup can release the member's runners.",
      },
      {
        path: "apps/api/src/lib/desktop-runner/",
        reason:
          "The gateway's tests read the stored rows to check what the socket acknowledged.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
