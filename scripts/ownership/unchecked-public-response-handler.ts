import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "unchecked-public-response-handler",
  capability: "Public route handlers without the 200-schema exactness guard",
  owner: ["apps/api/src/lib/api-handlers.ts"],
  summary:
    "`createSafeBoundedPublicHandler` requires a route's 200 schema and its " +
    "handler's success payload to be mutually assignable, so the schema Eden " +
    "types the client from cannot be looser than the data. The unchecked " +
    "core exists for a factory whose result type is still generic where it " +
    "builds the handler; that factory applies the guard on its own entry points.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/api-handlers"],
    names: ["createSafeUncheckedBoundedPublicHandler"],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/decisions/public-subject.ts",
        reason:
          "Builds gated subject handlers generically and guards both entry points.",
      },
      {
        path: "apps/api/src/lib/safe-handler-factories.type-test.ts",
        reason:
          "Reads the module's export names at type level to bind the factory map; calls nothing.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
