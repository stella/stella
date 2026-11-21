import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "pagination-cursor-schema",
  capability: "Cursor query fields on list endpoints",
  owner: ["apps/api/src/lib/custom-schema.ts"],
  summary:
    "Cursor query fields come from `tPaginationCursor`, so the byte cap is " +
    "one named constant rather than a literal repeated per route.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
