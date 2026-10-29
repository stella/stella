import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "printed-line-paragraphs",
  capability:
    "Reading a court's printed lines back as paragraphs: which line ends continue a paragraph and which hyphen the margin added",
  owner: ["apps/api/src/lib/legal-search/parsers/hard-wrapped-lines.ts"],
  summary:
    "Paragraphs are rebuilt at ingestion, once, for every jurisdiction; the " +
    "stored raw payload stays the verbatim published record. A parser that " +
    "joins lines with rules of its own fixes one source and leaves the same " +
    "defect in the others. `pl-printed-lines.ts` is a second reader of the " +
    "same capability (point geometry instead of character columns); it is " +
    "confined to its current callers and folds into the owner. Local joiners " +
    "that import nothing are caught by their output: the structure-fidelity " +
    "guard (`structure-fidelity-guard.test.ts`) holds every source's " +
    "fixtures to a shrink-only baseline.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/handlers/case-law/ingestion/parsers/pl-printed-lines"],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/ingestion/parsers/pl-sn.ts",
        reason: "Current caller; moves to the owner.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/parsers/pl-kio-layout.ts",
        reason: "Current caller; moves to the owner.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
