import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "rtf-reader",
  capability: "Decoding RTF control words and bytes",
  owner: [
    "apps/api/src/lib/legal-search/parsers/rtf-reader.ts",
    "apps/api/src/lib/legal-search/parsers/rtf-control-vocabulary.ts",
  ],
  summary:
    "All source parsers consume the shared RTF document reader. The document code-page control stays confined to that reader; fixtures may state it as input.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "ansicpg",
    allowed: [
      {
        path: "scripts/ownership/rtf-reader.ts",
        reason: "Declares the confined control word.",
      },
      {
        path: "apps/api/src/lib/legal-search/parsers/rtf-reader.test.ts",
        reason: "Exercises source byte decoding.",
      },
      {
        path: "apps/api/src/lib/legal-search/parsers/rtf-reader-owner.test.ts",
        reason: "Enumerates reader implementations.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/parsers/hu-bhgy.test.ts",
        reason: "Provides synthetic RTF input to the source parser.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/hu-bhgy.test.ts",
        reason: "Provides synthetic RTF input to the adapter.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/retention/sources/rtf-paragraphs.ts",
        reason:
          "The retention oracle's own reading of a publisher's RTF: it must not share the reader whose parse it checks.",
      },
      {
        path: ".oxlint-plugins/__tests__/confine-owner.test.ts",
        reason: "Verifies the rejecting second-reader mutation.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
