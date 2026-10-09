import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-canonical-source",
  capability:
    "Choosing where a legislation version's canonical AST or text is read from",
  owner: ["apps/api/src/lib/legal-search/legislation-canonical-source.ts"],
  summary:
    "The storage mode and the row's object key decide between object storage " +
    "and the Postgres copy. Readers and projections ask " +
    "`canonicalLegislationAstSource` or `canonicalLegislationTextSource`; " +
    "`legislation-canonical-source.test.ts` fails when a new file reads a " +
    "version's AST columns directly.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
