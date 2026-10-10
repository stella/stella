import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "review-organization-reset-fence",
  capability:
    "Locking the restricted review organization before each reset transaction",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "Runs the caller's organization-row lock and sole-membership check as the owner at the start of each scoped transaction, before the role switch; the caller receives a scoped database, never the pool.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["createFencedRlsDatabase"],
    allowed: [
      {
        path: "apps/api/src/lib/review-organization/reset.ts",
        reason:
          "Fences every reset transaction to the review account's sole membership.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
