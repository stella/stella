import { and, asc, eq, getTableName, gt, sql } from "drizzle-orm";

import {
  assertCallerOrg,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import { flowDefinitions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const FLOW_RESET_AUDITED_TABLES = [
  getTableName(flowDefinitions),
] as const;

export type ResetFlowCleanupOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  subject: SafeId<"schedulerJobRun">;
};

/** Cleanup and its count commit together; callers receive no feature data. */
export const cleanupFlowDefinitions = async ({
  tx,
  organizationId,
  subject,
}: ResetFlowCleanupOptions): Promise<void> => {
  let cursor: SafeId<"flowDefinition"> | undefined;
  let count = 0;
  for (;;) {
    // db-await-in-loop: discover each bounded page after the preceding scoped deletions.
    const page = await readCursorPage(
      tx
        .select({ id: flowDefinitions.id })
        .from(flowDefinitions)
        .where(
          and(
            eq(flowDefinitions.organizationId, organizationId),
            cursor === undefined ? undefined : gt(flowDefinitions.id, cursor),
          ),
        )
        .orderBy(asc(flowDefinitions.id)),
      { limit: LIMITS.flowDefinitionsCount, cursorForItem: (row) => row.id },
    );
    for (const row of page.items) {
      const where = sql`${and(eq(flowDefinitions.id, row.id), eq(flowDefinitions.organizationId, organizationId))}`;
      // db-await-in-loop: each row pins its own organization before the system role is installed.
      const proof = await proveOrgScope(tx, {
        table: "flowDefinitions",
        where,
      });
      const scope = proof.unwrapOr(null);
      if (scope === null || assertCallerOrg(scope, organizationId).isErr()) {
        continue;
      }
      // db-await-in-loop: scoped role settings are lent and restored serially on this transaction.
      count += await withOrgScope({
        tx,
        scope,
        actor: { type: "system" },
        fn: async (scopedTx) => {
          const changed = await scopedTx
            .delete(flowDefinitions)
            .where(
              and(
                eq(flowDefinitions.id, row.id),
                eq(flowDefinitions.organizationId, scope.organizationId),
              ),
            )
            .returning({ id: flowDefinitions.id });
          return changed.length;
        },
      });
    }
    const last = page.items.at(-1);
    if (page.nextCursor === null || last === undefined) {
      break;
    }
    cursor = last.id;
  }
  await recordSystemAudit(tx, "system:review-reset-flows-cleanup", {
    subject,
    counts: { flowDefinitions: count },
  });
};
