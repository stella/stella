import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "html-loader",
  capability: "String HTML and XML tree loading",
  owner: ["packages/html/src/load.ts"],
  summary:
    "Tree-based HTML consumers use @stll/html; Cheerio types come from cheerio/slim. One-pass extractors may use HTMLRewriter.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
