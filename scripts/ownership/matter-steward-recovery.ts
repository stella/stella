import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "matter-steward-recovery",
  capability: "Explicit named-steward recovery of an assigned-only orphan",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "Exposes one audited mutation without granting matter read access. The visibility owner locks and revalidates organization management authority, named internal membership and orphaned stewardship. Visibility remains assigned-only; callers receive no owner handle or matter metadata.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["recoverMatterSteward"],
    allowed: [
      {
        path: "apps/api/src/handlers/workspaces/steward/update.ts",
        reason:
          "Accepts an authenticated organization-management handover naming an internal steward.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
