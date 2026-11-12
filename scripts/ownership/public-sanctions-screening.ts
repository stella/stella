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
        path: "apps/api/src/handlers/health/routes.ts",
        reason:
          "Holds startup until anonymous sanctions matchers are terminal.",
      },
      {
        path: "apps/api/src/handlers/sanctions/search.ts",
        reason: "Screens anonymous subjects against the public corpus.",
      },
      {
        path: "apps/api/src/lib/smoke-session/store.ts",
        reason:
          "Reads list freshness as public screening sees it, to judge a staging journey's refresh job.",
      },
      {
        path: "apps/api/src/server.ts",
        reason: "Starts anonymous matcher warmup after the listener binds.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
