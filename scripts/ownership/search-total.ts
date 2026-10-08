import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "search-total",
  capability: "Declaring whether a search result total was counted",
  owner: [
    "packages/api-contract/src/search.ts",
    "apps/api/src/lib/search/total-schema.ts",
  ],
  summary:
    "One discriminated contract distinguishes an exact count, an estimate, " +
    "and a search that did not compute a count. The API schema enforces the " +
    "same closed branches at response boundaries, so consumers never infer " +
    "count semantics from null or from the search implementation.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
