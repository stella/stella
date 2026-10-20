import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "synthetic-principal-literals",
  capability: "Declaring stable monitoring identity literals",
  owner: ["apps/api/src/lib/synthetic-principal/"],
  summary:
    "Identity comparisons use the owning predicate; schema migrations enforce the same persisted identities.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "synthetic-prod-[a-z]+",
    allowed: [
      {
        path: "scripts/ownership/synthetic-principal-literals.ts",
        reason: "Declares the identity pattern.",
      },
      {
        path: "apps/api/drizzle/20261019070000_monitoring_session/",
        reason: "Enforces persisted identities.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
