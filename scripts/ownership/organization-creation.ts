import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "organization-creation",
  capability:
    "Inserting an organization row with its evaluation grant and account creation audit",
  owner: ["apps/api/src/lib/db/organization-creation.ts"],
  summary:
    "`createOrganizationWithEvaluation` and `insertOrganizationWithEvaluation` take " +
    "the account lock, claim a lifetime evaluation grant when access state is " +
    "enforced, write the organization and record `organization.created` (and " +
    "`organization.evaluation.started` for a grant) in the caller's transaction, " +
    "refusing at the limit with `organization_evaluation_limit_reached` before " +
    "anything is written. `createOrganizationForAccount` in `db/root.ts` routes the " +
    "organizations route and agent first-organization provisioning through the " +
    "organization plugin's create endpoint; the review account, smoke and " +
    "synthetic principal stores insert their fixed-id rows through the owner.",
  enforcement: {
    kind: "custom-rule",
    rule: "apps/api/src/tests/security/organization-creation-ownership.test.ts",
    reason:
      "Enumerates production Drizzle, raw SQL and organization plugin creates of organization rows; only the owner module inserts rows, only the endpoint adapter calls the plugin, and only the account owner receives the adapter.",
  },
} as const satisfies OwnershipEntry;
