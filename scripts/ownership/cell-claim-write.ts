import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "cell-claim-write",
  capability: "Claiming, settling and erroring a pending cell",
  owner: [
    "apps/api/src/lib/workflow-queue.ts",
    "apps/api/src/lib/workflow/orphan-cells.ts",
  ],
  summary:
    "A run's claim on a pending cell is its run, batch, deadline and attempt, written together when the cell is claimed and cleared together when it settles. The workflow queue claims and settles cells; orphan reconciliation errors the ones whose run is gone.",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/entities"],
    table: "fields",
    columns: ["ownerRunId", "ownerBatchId", "deadlineAt", "attempt"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
