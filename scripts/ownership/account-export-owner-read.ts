import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "account-export-owner-read",
  capability: "Reading account export data under account ownership",
  owner: ["apps/api/src/lib/account-export/owner-read.ts"],
  summary:
    "Sets account-export user and organization scope on the root connection before account-owned reads.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/rls"],
    names: [
      "SETTING_ACCOUNT_EXPORT_USER_ID",
      "SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID",
    ],
    allowed: [
      {
        path: "apps/api/src/db/schema/legal-reader.ts",
        reason: "Defines account-export row policies using the scope settings.",
      },
      {
        path: "apps/api/src/lib/account-export/pages.postgres.test.ts",
        reason: "Sets scope settings to verify adversarial account isolation.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
