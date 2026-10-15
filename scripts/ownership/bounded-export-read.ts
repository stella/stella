import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "bounded-export-read",
  capability: "Reading a complete set within an export row cap",
  owner: ["apps/api/src/lib/db/read-bounded.ts"],
  summary:
    "`readBounded` applies a cap-plus-one SQL limit and returns either the " +
    "complete rows or an explicit overflow result without a partial set. " +
    "`readCursorPage` uses the same sentinel and the existing `Page` owner " +
    "to preserve worker continuation without claiming a partial set is complete. " +
    "This owner handles expected export ceilings; `boundedAll` instead " +
    "panics when a write-path cardinality invariant is violated. " +
    "`scripts/transfer-read-guard.ts` enumerates fixed-limit reads and " +
    "enforces their shrink-only migration baseline.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
