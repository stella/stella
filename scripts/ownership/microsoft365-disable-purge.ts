import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "microsoft365-disable-purge",
  capability: "Purging organization-wide Microsoft 365 delegated credentials",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner exposes one organization-scoped revocation operation; callers receive no database handle and the owner transaction purges every delegated credential with its policy update and audit records.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["disableAndPurgeMicrosoft365ForOrg"],
    allowed: [
      {
        path: "apps/api/src/handlers/microsoft365/set-enablement.ts",
        reason:
          "The authorized organization disable handler invokes the bounded credential purge.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
