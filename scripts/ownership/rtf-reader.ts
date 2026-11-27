import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "rtf-reader",
  capability: "Decoding RTF control words and bytes",
  owner: [
    "packages/case-law-parsers/src/rtf-reader.ts",
    "packages/case-law-parsers/src/rtf-control-vocabulary.ts",
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
        path: "packages/case-law-parsers/src/rtf-reader.test.ts",
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
        path: "apps/api/src/lib/files/rtf-body.ts",
        reason:
          "An Outlook message body, not a document: it de-encapsulates the HTML an RTF body carries ([MS-OXRTFEX]) and shows a plain RTF body as its text.",
      },
      {
        path: "apps/api/src/lib/files/rtf-body.test.ts",
        reason: "Provides synthetic RTF message bodies to the body reader.",
      },
      {
        path: "apps/api/src/tests/fixtures/tnef.ts",
        reason: "Provides a synthetic RTF body inside a TNEF stream.",
      },
      {
        path: ".oxlint-plugins/__tests__/confine-owner.test.ts",
        reason: "Verifies the rejecting second-reader mutation.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
