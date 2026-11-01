import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "workspace-search-activity-actor",
  capability: "Minting the workspace search activity scope actor",
  owner: ["apps/api/src/lib/db/workspace-search-activity-actor.ts"],
  summary:
    "The private actor contract is shared as a type, while only search bookkeeping may construct its runtime brand.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/workspace-search-activity-actor"],
    names: ["createWorkspaceSearchActivityActor"],
    allowed: [
      {
        path: "apps/api/src/lib/db/recovery-bookkeeping/search.ts",
        reason:
          "Constructs the actor only while refreshing the owned search projection.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
