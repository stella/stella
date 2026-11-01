import { eq, sql } from "drizzle-orm";

import { withOrgScope } from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import { flowRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { FLOW_RUN_RECOVERY_TRANSITIONS } from "@/api/lib/db/flow-run-transition-spec";
import { transitionNullableScopedCount } from "@/api/lib/db/transitions";
import { logger } from "@/api/lib/observability/logger";

type DeferredNoticeOperation = {
  type: "actor-removed" | "completion-notice-pending" | "clear";
  scope: OrgScope;
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
};

/** Caller holds the completed-run lock; only notice recovery bookkeeping changes. */
export const recordDeferredNoticeState = async (
  tx: ScopedTransaction,
  operation: DeferredNoticeOperation,
): Promise<void> => {
  await withOrgScope({
    tx,
    scope: operation.scope,
    actor: { type: "system" },
    fn: async (scopedTx) => {
      await transitionNullableScopedCount({
        tx: scopedTx,
        spec: FLOW_RUN_RECOVERY_TRANSITIONS,
        to: operation.type === "clear" ? null : operation.type,
        where: sql`${eq(flowRuns.id, operation.runId)}
      AND ${eq(flowRuns.workspaceId, operation.workspaceId)}
      AND ${eq(flowRuns.status, "completed")}`,
        recordTransitionAuditEvent: (_tx, count) => {
          logger.info("flow.notice_recovery_updated", {
            operation: operation.type,
            count,
          });
        },
      });
    },
  });
};
