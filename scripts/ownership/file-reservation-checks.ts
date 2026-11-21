import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "file-reservation-checks",
  capability: "Checking stored object admission",
  owner: ["apps/api/src/lib/files/organization-file-usage.ts"],
  summary: "Reservation writes run through the owner's admitted continuation.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/organization-file-usage"],
    names: ["reserveOrganizationFileBytes", "reserveOrganizationFilesBytes"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
