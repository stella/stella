import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "public-sanctions-reader-binding",
  capability:
    "Binding the public sanctions reader to the scoped connection pool",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The connection owner constructs a column-restricted, read-only " +
    "sanctions reader without exporting another raw connection handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["createPublicSanctionsReader"],
    allowed: [
      {
        path: "apps/api/src/lib/lists/sanctions/public-read-owner.ts",
        reason: "Owns the restricted anonymous screening handle.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
