import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-plain-text",
  capability:
    "Sanitizing publisher labels and metadata into branded plain text",
  owner: [
    "apps/api/src/lib/case-law/plain-text.ts",
    "apps/api/src/lib/legal-search/plain-text-assembly.ts",
    "apps/api/src/lib/case-law/plain-text-markup.ts",
  ],
  summary:
    "The shared sanitizer owns the private PlainText brand, markup removal, " +
    "and structural whitespace normalization. Adapters pass publisher text " +
    "through this boundary; no-forged-plain-text rejects casts, type predicates, " +
    "and parallel brand declarations outside the owner. The markup module " +
    "shares the language-blind output predicate used by ingestion guards.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
