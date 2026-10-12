import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "file-reservation-evidence",
  capability: "Authorizing stored object writes",
  owner: [
    "apps/api/src/lib/files/organization-file-usage.ts",
    "apps/api/src/lib/files/copy-organization-files.ts",
    "apps/api/src/lib/uploads/promote-tmp-object.ts",
  ],
  summary:
    "Stored object writers execute through an authorization carrying their complete input and reservation identity.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/organization-file-usage"],
    names: ["authorizeOrganizationFileWrite", "authorizeOrganizationFileBatch"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
