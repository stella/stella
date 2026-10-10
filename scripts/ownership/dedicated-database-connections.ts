import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "dedicated-database-connections",
  capability:
    "Admitting dedicated database sessions within one process ceiling",
  owner: ["apps/api/src/db/dedicated-connection-slots.ts"],
  summary:
    "The owner admits maintenance sessions and cancellable work together, reserving cancellation capacity before work opens.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/dedicated-connection-slots"],
    allowed: [
      {
        path: "apps/api/src/db/long-running-connection.ts",
        reason:
          "Owns dedicated work and waits for cancellation before closing.",
      },
      {
        path: "apps/api/src/db/dedicated-connection-slots.test.ts",
        reason: "Exercises bounded admission with isolated process state.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
