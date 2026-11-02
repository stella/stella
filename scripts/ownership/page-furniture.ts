import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "page-furniture",
  capability:
    "Recognising page furniture in court text: running headers, page numbers, soft hyphens, and sentences a page break cut",
  owner: ["apps/api/src/lib/legal-search/parsers/page-furniture.ts"],
  summary:
    "Running headers and page numbers are the page's, not the court's, and " +
    "a sentence a page break cut is one paragraph. Parsers ask the owner " +
    "about their lines; a jurisdiction's header form is added to the owner, " +
    "not to its parser. A furniture rule written inside a parser imports " +
    "nothing a lint rule could confine, so the structure-fidelity guard " +
    "(`structure-fidelity-guard.test.ts`) reads every source's fixtures for " +
    "page-number blocks and cut sentences against a shrink-only baseline.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
