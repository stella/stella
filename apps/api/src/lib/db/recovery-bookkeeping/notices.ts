import { eq, sql } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type { flowRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { FLOW_RUN_RECOVERY_TRANSITIONS } from "@/api/lib/db/flow-run-transition-spec";
import { transitionNullableScopedCount } from "@/api/lib/db/transitions";
import { logger } from "@/api/lib/observability/logger";

type DeferredNoticeOperation = {
  type: "actor-removed" | "completion-notice-pending" | "clear";
  table: typeof flowRuns;
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
};

/** Caller holds the completed-run lock; only notice recovery bookkeeping changes. */
export const recordDeferredNoticeState = async (
  tx: ScopedTransaction,
  operation: DeferredNoticeOperation,
): Promise<void> => {
  await transitionNullableScopedCount({
    tx,
    spec: FLOW_RUN_RECOVERY_TRANSITIONS,
    to: operation.type === "clear" ? null : operation.type,
    where: sql`${eq(operation.table.id, operation.runId)}
      AND ${eq(operation.table.workspaceId, operation.workspaceId)}
      AND ${eq(operation.table.status, "completed")}`,
    recordTransitionAuditEvent: (_tx, count) => {
      logger.info("flow.notice_recovery_updated", {
        operation: operation.type,
        count,
      });
    },
  });
};
