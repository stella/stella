import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "maintenance-session-initialization",
  capability: "Transferring initialized maintenance session ownership",
  owner: ["apps/api/src/lib/case-law/maintenance-lane.ts"],
  summary: "Initialization failures release the held lane before propagating.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/case-law/maintenance-lane"],
    names: ["createMaintenanceLaneSession"],
    allowed: [
      {
        path: "apps/api/src/lib/case-law/maintenance-lane.test.ts",
        reason:
          "Exercises initialization failure without loading database singletons.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
