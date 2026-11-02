import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "html-loader",
  capability: "String HTML and XML tree loading",
  owner: [
    "packages/html/src/load.ts",
    "packages/html/src/nodes.ts",
    "packages/html/src/selection.ts",
    "packages/html/src/email.ts",
    "packages/html/src/bounded.ts",
  ],
  summary:
    "Tree-based HTML consumers use @stll/html; Node and selection types, email serialization and bounded parsing share that owner. One-pass extractors may use HTMLRewriter.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
