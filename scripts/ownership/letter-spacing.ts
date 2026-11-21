import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "letter-spacing",
  capability:
    "Reading letter-spaced display type (`r o z h o d l`, `p o s t a n a w i a`) as words",
  owner: [
    "packages/text-normalize/src/letter-spacing.ts",
    "apps/api/src/lib/legal-search/parsers/letter-spacing.ts",
  ],
  summary:
    "Courts across jurisdictions set operative verbs and section titles in " +
    "spaced letters. `collapseLetterSpacing` reads them as words and keeps " +
    "the word gaps a parser would otherwise squeeze (`týmspáchal`); " +
    "`collapseSpacedLetters` is the same reading folded for search and the " +
    "role vocabularies, and `letterSpacingJoins` names the gaps the reader " +
    "and find-in-page hide. Parsers read inline trees and blocks through " +
    "`readInlineLetterSpacing` and `withAttestedLetterSpacing` in the API.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-local-letter-spacing/no-local-letter-spacing",
    reason:
      "A local reading is a regular expression that joins two letters " +
      "across a gap or repeats a letter and a gap; no import names it.",
  },
} as const satisfies OwnershipEntry;
