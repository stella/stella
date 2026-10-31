import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-completeness-census",
  capability: "Comparing stored case law with publisher slice observations",
  owner: [
    "apps/api/src/lib/case-law/completeness-census.ts",
    "apps/api/src/lib/case-law/completeness-census-writer.ts",
    "apps/api/src/lib/case-law/completeness-census-contract.ts",
    "apps/api/src/lib/case-law/completeness-census-values.ts",
    "apps/api/src/lib/case-law/completeness-census-capabilities.ts",
  ],
  summary:
    "Normal reconciliation walks feed one leased, idempotent observation store through the private writer. " +
    "Public readers import only the bounded aggregate read owner. " +
    "The owner counts stored identities and text, aggregates bounded year and worst-slice summaries, " +
    "and derives source and country verdicts. Missing slices and partial publisher scope cannot certify completeness.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/case-law"],
    names: ["caseLawCompletenessCensus"],
    allowed: [
      {
        path: "apps/api/src/db/entity-feature-gate-repair.ts",
        reason:
          "Full-schema policy introspection: renders the entity feature policies the online cutover installs; reads no rows.",
      },
      {
        path: "apps/api/src/lib/case-law/completeness-census.postgres.test.ts",
        reason:
          "Exercises census persistence, reader grants and conservative verdicts against PostgreSQL.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
