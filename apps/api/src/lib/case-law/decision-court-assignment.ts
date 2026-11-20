import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import {
  CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE,
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";

type DecisionCourtIdAssignment = {
  decisionId: SafeId<"caseLawDecision">;
  court: string;
  courtId: string;
};

type AssignDecisionCourtIdsOptions = {
  sourceId: SafeId<"caseLawSource">;
  assignments: readonly DecisionCourtIdAssignment[];
};

/** Court IDs affect ranking fingerprints even when the printed court is unchanged. */
export const assignDecisionCourtIdsTx = async (
  tx: Transaction,
  { sourceId, assignments }: AssignDecisionCourtIdsOptions,
): Promise<SafeId<"caseLawDecision">[]> => {
  if (
    assignments.length > CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE ||
    new Set(assignments.map(({ decisionId }) => decisionId)).size !==
      assignments.length
  ) {
    return panic("Court ID assignment requires one bounded unique batch");
  }
  if (assignments.length === 0) {
    return [];
  }
  const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "case_law",
    sourceId,
  });
  await lockCaseLawDecisionRows({
    tx,
    decisionIds: assignments.map(({ decisionId }) => decisionId),
  });
  const values = JSON.stringify(
    assignments.map(({ decisionId, courtId, court }) => ({
      id: decisionId,
      court_id: courtId,
      court,
    })),
  );
  // audit: skip - public corpus identity enrichment has no matter audit scope.
  const changed = await tx
    .update(caseLawDecisions)
    .set({
      courtId: sql`assignment.court_id`,
      updatedAt: caseLawDecisions.updatedAt,
    })
    .from(
      sql`jsonb_to_recordset(${values}::text::jsonb) AS assignment(id uuid, court_id text, court text)`,
    )
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        isNull(caseLawDecisions.courtId),
        sql`${caseLawDecisions.id} = assignment.id`,
        sql`${caseLawDecisions.court} = assignment.court`,
      ),
    )
    .returning({ id: caseLawDecisions.id });
  const decisionIds = changed.map(({ id }) => id);
  if (lock !== null && decisionIds.length > 0) {
    await synchronizeLockedCaseLawProjectionBatchTx(tx, {
      lock,
      sourceId,
      decisionIds,
    });
  }
  return decisionIds;
};
