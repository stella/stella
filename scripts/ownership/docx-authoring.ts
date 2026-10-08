import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "docx-authoring",
  capability:
    "Producing DOCX bytes from Markdown, legal source, or a document model, and applying AI edits to a DOCX",
  owner: [
    "apps/api/src/lib/docx-authoring/",
    "apps/web/src/components/chat/create-document-compiler.ts",
  ],
  summary:
    "The compilers and the serialiser are external packages; the owner is the " +
    "one place that drives them, so every document stella writes carries its " +
    "house styles and the same edit attribution. Model-written Markdown goes " +
    "through `markdownToStellaDocx`, a draft in the legal-source markup through " +
    "`legalSourceToDocx`, a model built in this repository through " +
    "`stellaDocument` and `documentToDocx`, and AI edits through " +
    "`applyAiEditsToDocx`. The web owner compiles legal source for the " +
    "in-browser draft preview. None of this patches an existing template.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@stll/docx-core",
      "@stll/folio-core",
      "@stll/folio-core/markdown",
      "@stll/folio-core/server",
    ],
    names: [
      "applyFolioAIEditsToBuffer",
      "compileLegalSourceToDocument",
      "compileLegalSourceToDocx",
      "createDocx",
      "fromMarkdown",
      "serializeDocumentToDocx",
    ],
    allowed: [
      {
        path: "apps/api/evals/create-document-drafting.ts",
        reason:
          "Scoring harness: compiles the model's legal source to read the compiler's own diagnostics (errors, fixes, warnings) and never writes a document.",
      },
      {
        path: "apps/api/src/lib/file-scan/document-parsers.ts",
        reason:
          "Parse boundary: wraps applyFolioAIEditsToBuffer so its input must be a ScannedFile; applyAiEditsToDocx in the owner calls the wrapper, so edit attribution stays with the owner.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
