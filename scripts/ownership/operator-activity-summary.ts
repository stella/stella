import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "operator-activity-summary",
  capability: "Serving audited operator activity aggregates",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "Reads deployment-wide bounded time-window counts through the owner connection and records each read transactionally; callers receive aggregates, never a database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["readOperatorActivitySummary"],
    allowed: [
      {
        path: "apps/api/src/handlers/operator/activity.ts",
        reason:
          "Authorizes the deployment credential before reading activity aggregates.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
