import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "organization-slug-update",
  capability:
    "Changing organization slugs through Better Auth with transactional audit",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The authenticated slug operation revalidates and locks organization membership, calls Better Auth with a transaction-bound adapter, and records the old and new slug in that transaction. Callers receive a typed outcome, never an owner database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["changeOrganizationSlug"],
    allowed: [
      {
        path: "apps/api/src/handlers/organizations/slug/update.ts",
        reason:
          "Enforces account and credential restrictions before changing the authenticated organization's slug.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
