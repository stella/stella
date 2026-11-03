import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "court-pdf-text-layer",
  capability: "Reading a court PDF's text layer: lines, fonts and positions",
  owner: ["apps/api/src/lib/legal-search/parsers/libpdf-utils.ts"],
  summary:
    "A parser that reads a PDF's text layer itself also has to rebuild " +
    "paragraphs, drop page furniture and lift superscripts itself, and every " +
    "such reader has grown its own partial copy of that work. Court parsers " +
    "read printed lines through the shared reader and hand them to the " +
    "printed-line owners (`hard-wrapped-lines.ts`, `page-furniture.ts`, " +
    "`letter-spacing.ts`); the structure-fidelity guard checks the result " +
    "over every source's fixtures.",
  enforcement: {
    kind: "member-call",
    method: "extractText",
    within: [
      "apps/api/src/handlers/case-law/",
      "apps/api/src/handlers/legislation/",
      "apps/api/src/lib/legal-search/",
    ],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/sk-collections.ts",
        reason:
          "Reads a collection index's lines to locate decisions, not decision text, and checks the page limit before extracting; moves into the owner once it reads page counts.",
      },
      {
        path: "apps/api/src/lib/legal-search/soft-law-document-text.ts",
        reason:
          "Soft-law documents keep the PDF's plain text, not court paragraphs.",
      },
      {
        path: "apps/api/src/lib/legal-search/document-builders/replay.test.ts",
        reason: "Test oracle reads the fixture PDF independently.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/cz-uohs.test.ts",
        reason: "Test oracle reads the fixture PDF independently.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
