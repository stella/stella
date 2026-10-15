import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "public-sanctions-screening",
  capability: "Reading the public sanctions corpus for anonymous screening",
  owner: ["apps/api/src/lib/lists/sanctions/public-read-owner.ts"],
  summary:
    "Anonymous screening uses a column-restricted reader role and read-only " +
    "transactions. This owner exports the restricted screening handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/lists/sanctions/public-read-owner"],
    allowed: [
      {
        path: "apps/api/src/handlers/sanctions/search.ts",
        reason: "Screens anonymous subjects against the public corpus.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
