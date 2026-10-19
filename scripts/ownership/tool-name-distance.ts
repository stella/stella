import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "tool-name-distance",
  capability: "Tool name distance calculation",
  owner: ["packages/mcp-kit/src/envelope.ts"],
  summary:
    "Tool name suggestions share one bounded comparison implementation and one normalization path.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/fuzzy-search"],
    names: ["distance"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
