import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-publication",
  capability: "Selecting jurisdictions admitted to public statute reads",
  owner: [
    "packages/api-contract/src/legislation-publication.ts",
    "apps/api/src/lib/legal-search/legislation-redistribution.ts",
  ],
  summary:
    "Statute jurisdiction admission is independent of case-law corpus readiness. " +
    "Collection, identifier, version, snippet and sitemap reads combine that admission with source redistribution permission.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/legal-search/legislation-redistribution"],
    names: ["redistributableLegislationSource"],
    allowed: [
      {
        path: "apps/api/src/handlers/legislation/non-redistributable-sources.ts",
        reason:
          "The source inventory describes redistribution restrictions independently of publication admission.",
      },
      {
        path: "apps/api/src/handlers/legislation/search-index.ts",
        reason:
          "Background indexing retains the broader corpus; public search applies admission when querying and hydrating hits.",
      },
      {
        path: "apps/api/src/handlers/legislation/search.ts",
        reason:
          "The PostgreSQL search projection aliases its country column and pairs source permission with publishedLegislationCountryFor.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
