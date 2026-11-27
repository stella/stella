import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "owner-organization-scope",
  capability:
    "Naming the organization for owner-connection access to organization-scoped tables",
  owner: ["apps/api/src/lib/db/owner-organization-scope.ts"],
  summary:
    "`contacts` forces row security on its owner, whose policy admits the " +
    "organization the transaction names. `withOwnerOrganizationScope` is the " +
    "one place owner-connection code names it: it takes the owner database or " +
    "an owner transaction, refuses any role but the table owner and any " +
    "change of an organization the transaction already names, and hands the " +
    "enclosing setting back. Each importer below reaches contacts on the " +
    "owner connection for one organization it already holds; the contacts " +
    "owner-scope census pins every call site.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/owner-organization-scope"],
    allowed: [
      {
        path: "apps/api/src/lib/member-assignment-offboarding.ts",
        reason:
          "Clears a departing member's contact attorney references per organization: the one they leave, or each membership of a deleted account.",
      },
      {
        path: "apps/api/src/lib/search/projection-repair-queue.ts",
        reason:
          "Rebuilds a queued contact or matter projection inside the organization stored with its queue row.",
      },
      {
        path: "apps/api/src/lib/search/index-global.ts",
        reason:
          "Rebuilds the supplemental search index of the organization the development route names.",
      },
      {
        path: "apps/api/src/lib/review-organization/reset.ts",
        reason:
          "Enumerates the contacts of the configured review organization before deleting them.",
      },
      {
        path: "apps/api/src/lib/review-organization/reset-scope.ts",
        reason:
          "Sweeps owner-scoped tables of the review organization the reset resolved.",
      },
      {
        path: "apps/api/scripts/seed-dev.ts",
        reason: "Writes the development seed organization's contacts.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/issuance.ts",
        reason:
          "Mints a desktop account credential inside the organization the connection request authorized.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/renewal.ts",
        reason:
          "Rotates and probes a desktop account credential inside the credential's verified organization.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/revocation.ts",
        reason:
          "Revokes a desktop account credential and releases its runners inside the credential's organization.",
      },
      {
        path: "apps/api/src/lib/flows/maybe-start-upload-triggered-flows.ts",
        reason:
          "Loads enabled file-upload flow definitions inside the uploaded entity's organization.",
      },
      {
        path: "apps/api/src/lib/machine-api-key-queries.ts",
        reason:
          "Reads machine API keys on the owner connection inside the caller's validated organization.",
      },
      {
        path: "apps/api/src/lib/search/pg-fts-provider.ts",
        reason:
          "Enumerates workspaces and entities for full-text index rebuild inside the target organization.",
      },
      {
        path: "apps/api/src/lib/sharepoint-disable-purge.ts",
        reason:
          "Disables SharePoint policy and purges stored connections inside the target organization.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
