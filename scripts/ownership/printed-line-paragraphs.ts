import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "printed-line-paragraphs",
  capability:
    "Reading a court's printed lines back as paragraphs: which line ends continue a paragraph, which hyphen the margin added, and where a printed label opens a paragraph",
  owner: [
    "apps/api/src/lib/legal-search/parsers/hard-wrapped-lines.ts",
    "packages/legal-ast/src/printed-paragraph-labels.ts",
  ],
  summary:
    "Paragraphs are rebuilt at ingestion, once, for every jurisdiction; the " +
    "stored raw payload stays the verbatim published record. A parser that " +
    "joins lines with rules of its own fixes one source and leaves the same " +
    "defect in the others. `hard-wrapped-lines.ts` reads both character " +
    "columns (typescripts) and positioned lines (PDF text layers, converted " +
    "pages); the printed-label grammar (`printedLabelOpensParagraph`, " +
    "`readPrintedLabel`) decides where a label (`12.`, `5.5.`, `[12]`, `a)`) " +
    "opens a paragraph, the court numbering reads the same markers, and a " +
    "wrapped date or citation never opens one. Local joiners that match no " +
    "label are caught by their output: the structure-fidelity guard " +
    "(`structure-fidelity-guard.test.ts`) holds every source's fixtures to a " +
    "shrink-only baseline.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-local-paragraph-label/no-local-paragraph-label",
    reason:
      "A local reading is a regular expression anchored at a line start " +
      "that opens with a number closed the way a label is; no import names it.",
  },
} as const satisfies OwnershipEntry;
