import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "review-account-provisioning",
  capability:
    "Provisioning the restricted review account's organization and owner membership",
  owner: [
    "apps/api/src/db/root.ts",
    "apps/api/src/lib/db/review-account-organization-store.ts",
  ],
  summary:
    "The organization plugin refuses the review account by policy, so its single organization, the creation seeds and the owner membership are written on the owner connection in one transaction. The connection owner binds the store; the operator command receives the operations, never a database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["bindOwnerReviewAccountOrganizationStore"],
    allowed: [
      {
        path: "apps/api/src/scripts/review-account.ts",
        reason: "Command that provisions the restricted review account.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
