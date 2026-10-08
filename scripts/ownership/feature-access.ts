import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "feature-access",
  capability: "Deciding caller feature admission and discovery",
  owner: [
    "apps/api/src/lib/auth/feature-access/policy.ts",
    "apps/api/src/lib/auth/feature-access/context.ts",
    "apps/api/src/lib/feature-access/registry.ts",
    "apps/api/src/mcp/feature-access.ts",
  ],
  summary:
    "The feature registry declares enrolment and ownership. One principal-bound policy decides admission and discovery; the catalog declaration guard and real discovery tests enforce the boundary.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
