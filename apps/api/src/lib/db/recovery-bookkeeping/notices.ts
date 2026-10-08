import { and, eq } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type { flowRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeferredNoticeOperation = {
  type: "actor-removed" | "completion-notice-pending" | "clear";
  table: typeof flowRuns;
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
};

/** Caller holds the admitted completed-run transaction; no outcome is changed. */
export const recordDeferredNoticeState = async (
  tx: ScopedTransaction,
  operation: DeferredNoticeOperation,
): Promise<void> => {
  // audit: skip - delivery bookkeeping preserves the completed run and its existing outcome.
  await tx
    .update(operation.table)
    .set({ recoveryState: operation.type === "clear" ? null : operation.type })
    .where(
      and(
        eq(operation.table.id, operation.runId),
        eq(operation.table.workspaceId, operation.workspaceId),
        eq(operation.table.status, "completed"),
      ),
    );
};
