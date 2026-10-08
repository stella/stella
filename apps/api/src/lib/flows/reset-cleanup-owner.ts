import { panic } from "better-result";
import { getTableName, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { flowDefinitions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
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
  const row = executedRows(
    await tx.execute(sql`
    WITH removed AS (DELETE FROM ${flowDefinitions}
      WHERE ${flowDefinitions.organizationId} = ${organizationId} RETURNING 1)
    SELECT count(*)::int AS n FROM removed
  `),
  ).at(0);
  if (
    typeof row !== "object" ||
    row === null ||
    !("n" in row) ||
    typeof row.n !== "number" ||
    !Number.isSafeInteger(row.n) ||
    row.n < 0
  ) {
    panic("Flow cleanup must return its non-negative deletion count");
  }
  await recordSystemAudit(tx, "system:review-reset-flows-cleanup", {
    subject,
    counts: { flowDefinitions: row.n },
  });
};
