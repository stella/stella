import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "charset-misdecoding",
  capability: "Detecting and undoing text decoded with the wrong character set",
  owner: ["packages/mojibake/"],
  summary:
    "Ingestion guards and corpus checks judge a text against its declared " +
    "language's CLDR exemplar letters, which covers every language CLDR " +
    "does and needs no reader of the language. A check that lists letters " +
    "or byte pairs for one language is a second, narrower detector; extend " +
    "this one.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
