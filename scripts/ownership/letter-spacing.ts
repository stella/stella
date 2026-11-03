import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "letter-spacing",
  capability:
    "Reading letter-spaced display type (`r o z h o d l`, `p o s t a n a w i a`) as words",
  owner: ["apps/api/src/lib/legal-search/parsers/letter-spacing.ts"],
  summary:
    "Courts across jurisdictions set operative verbs and section titles in " +
    "spaced letters. The owner keeps the word gaps a parser would otherwise " +
    "squeeze (`týmspáchal`) and is what a role or heading rule matches " +
    "against, so a spaced `U z a s a d n i e n i e` reads as the reasons " +
    "heading in every source. A local spacing rule imports nothing a lint " +
    "rule could confine; the structure-fidelity guard reads the output.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
