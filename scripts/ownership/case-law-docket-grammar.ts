import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-docket-grammar",
  capability: "Parsing and comparing decision docket identifiers",
  owner: [
    "packages/api-contract/src/decision-docket-grammar.ts",
    "packages/api-contract/src/decision-query-intent.ts",
  ],
  summary:
    "One total jurisdiction map recognizes docket syntax and returns normalized display and comparison forms. " +
    "Search intent classification and exact result matching use that same parser, so a spelling cannot be classified under one rule and compared under another.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
