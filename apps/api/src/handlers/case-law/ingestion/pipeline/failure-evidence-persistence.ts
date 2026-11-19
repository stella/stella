import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { declareFingerprintFields } from "@stll/errors";

import {
  CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
  onlineUniqueIndexTarget,
} from "@/api/db/online-unique-indexes";
import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawHeldDecisionAttachments,
  caseLawIngestionFailureEvidence,
  caseLawIngestionFailures,
} from "@/api/db/schema";
import {
  captureFailureEvidence,
  encodeIngestionFailureEvidence,
  type IngestionFailureEvidence,
  type IngestionFailureIdentityKind,
  ingestionFailureRecordIdentity,
} from "@/api/handlers/case-law/ingestion/pipeline/failure-evidence";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";

type FailureEvidenceRow = typeof caseLawIngestionFailureEvidence.$inferInsert;

/** Clear retained inputs after canonical attachment or a host's withdrawal. */
export const clearIngestionFailureEvidenceTx = async (
  tx: Transaction,
  {
    sourceId,
    sourceDocumentId,
  }: { sourceId: SafeId<"caseLawSource">; sourceDocumentId: string },
): Promise<void> => {
  // audit: skip — ingestion lifecycle for retained publisher inputs
  await tx
    .delete(caseLawIngestionFailureEvidence)
    .where(
      and(
        eq(caseLawIngestionFailureEvidence.sourceId, sourceId),
        eq(caseLawIngestionFailureEvidence.sourceDocumentId, sourceDocumentId),
      ),
    );
};

/** A takedown serializes with the same decision lock before dropping evidence. */
const protectFailureEvidenceTx = async (
  tx: Transaction,
  row: FailureEvidenceRow,
): Promise<FailureEvidenceRow> => {
  if (row.sourceDocumentId === undefined || row.sourceDocumentId === null) {
    return row;
  }
  const own = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, row.sourceId),
        eq(caseLawDecisions.sourceDocumentId, row.sourceDocumentId),
      ),
    );
  const identities = await tx
    .select({
      id: canonicalDecisionIdSql(caseLawDecisionSourceIdentities.decisionId),
    })
    .from(caseLawDecisionSourceIdentities)
    .where(
      and(
        eq(caseLawDecisionSourceIdentities.sourceId, row.sourceId),
        eq(
          caseLawDecisionSourceIdentities.sourceDocumentId,
          row.sourceDocumentId,
        ),
      ),
    );
  const attached = await tx
    .select({
      id: canonicalDecisionIdSql(caseLawHeldDecisionAttachments.hostDecisionId),
    })
    .from(caseLawHeldDecisionAttachments)
    .where(
      and(
        eq(caseLawHeldDecisionAttachments.sourceId, row.sourceId),
        eq(
          caseLawHeldDecisionAttachments.sourceDocumentId,
          row.sourceDocumentId,
        ),
        isNotNull(caseLawHeldDecisionAttachments.hostDecisionId),
      ),
    );
  const decisionIds = [
    ...new Set([...own, ...identities, ...attached].map(({ id }) => id)),
  ];
  if (decisionIds.length === 0) {
    return row;
  }
  await lockCaseLawDecisionRows({ tx, decisionIds });
  const live = await tx
    .select({ redactedAt: caseLawDecisions.redactedAt })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, decisionIds));
  if (
    live.length === decisionIds.length &&
    live.every(({ redactedAt }) => redactedAt === null)
  ) {
    return row;
  }
  await clearIngestionFailureEvidenceTx(tx, {
    sourceId: row.sourceId,
    sourceDocumentId: row.sourceDocumentId,
  });
  return {
    ...row,
    ...encodeIngestionFailureEvidence({
      type: "withdrawn",
      sourceDocumentId: row.sourceDocumentId,
    }),
  };
};

export type IngestionFailureRow =
  typeof caseLawIngestionFailures.$inferInsert & {
    replayEvidence?: IngestionFailureEvidence;
    identityKind?: IngestionFailureIdentityKind;
  };

/** Column bounds of `case_law_ingestion_failures` (schema/case-law.ts). */
const INGESTION_FAILURE_LIMITS = {
  caseNumber: 256,
  language: 8,
  errorType: 128,
  errorMessage: 2048,
} as const;

/** Postgres text and jsonb columns do not store NUL characters. */
const storableText = (value: string, maxLength?: number): string => {
  const text = value.replaceAll("\u0000", "");
  return maxLength === undefined ? text : text.slice(0, maxLength);
};

/**
 * A failure row as the table accepts it: values copied from the decision
 * that failed are held to the column bounds and carry no NUL characters.
 */
const storableIngestionFailure = (
  row: IngestionFailureRow,
): IngestionFailureRow => ({
  ...row,
  caseNumber: storableText(row.caseNumber, INGESTION_FAILURE_LIMITS.caseNumber),
  errorType: storableText(row.errorType, INGESTION_FAILURE_LIMITS.errorType),
  errorMessage: storableText(
    row.errorMessage,
    INGESTION_FAILURE_LIMITS.errorMessage,
  ),
  ...(typeof row.language === "string"
    ? {
        language: storableText(row.language, INGESTION_FAILURE_LIMITS.language),
      }
    : {}),
  ...(typeof row.cursor === "string"
    ? { cursor: storableText(row.cursor) }
    : {}),
});

type IngestionFailureRowsWrite = { type: "written" } | { type: "unreplayable" };

export const writeIngestionFailureRowsTx = async (
  tx: Transaction,
  failures: readonly IngestionFailureRow[],
): Promise<IngestionFailureRowsWrite> => {
  if (failures.length === 0) {
    return { type: "written" };
  }
  const rows = failures.map(
    ({ replayEvidence: _evidence, identityKind: _kind, ...row }) =>
      storableIngestionFailure(row),
  );
  const evidenceRows = failures.flatMap(
    ({ replayEvidence, recordIdentity, identityKind, sourceId, errorType }) =>
      replayEvidence === undefined ||
      identityKind === undefined ||
      recordIdentity === undefined ||
      recordIdentity === null
        ? []
        : [
            {
              ...replayEvidence,
              recordIdentity,
              identityKind,
              sourceId,
              errorType: storableText(errorType, 128),
            },
          ],
  );
  const identified = rows.filter(
    ({ recordIdentity }) => typeof recordIdentity === "string",
  );
  const anonymous = rows.filter(
    ({ recordIdentity }) => typeof recordIdentity !== "string",
  );
  const protectedRows = [];
  for (const row of evidenceRows) {
    // db-await-in-loop: lock each known decision before retaining its publisher bytes
    protectedRows.push(await protectFailureEvidenceTx(tx, row));
  }
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  if (anonymous.length > 0) {
    // Rows without an identity insert as they always have.
    await tx.insert(caseLawIngestionFailures).values(anonymous);
  }
  if (identified.length > 0) {
    // A row that names its record's identity lands once: a replay of the
    // same record meets the partial unique index and keeps the row already
    // there. Only that index's conflict is absorbed.
    await tx
      .insert(caseLawIngestionFailures)
      .values(identified)
      .onConflictDoNothing({
        target: onlineUniqueIndexTarget(
          CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
          caseLawIngestionFailures,
        ),
        where: isNotNull(caseLawIngestionFailures.recordIdentity),
      });
  }
  if (protectedRows.length > 0) {
    await tx
      .insert(caseLawIngestionFailureEvidence)
      .values(protectedRows)
      .onConflictDoNothing({
        target: [
          caseLawIngestionFailureEvidence.sourceId,
          caseLawIngestionFailureEvidence.recordIdentity,
          caseLawIngestionFailureEvidence.payloadHash,
          caseLawIngestionFailureEvidence.errorType,
        ],
      });
  }
  return evidenceRows.length === failures.length
    ? { type: "written" }
    : { type: "unreplayable" };
};

export class IngestionFailureEvidenceError extends TaggedError(
  "IngestionFailureEvidenceError",
)<{
  message: string;
  reason: "capture" | "unaddressable";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type ParkIngestionFailureOptions = {
  sourceId: SafeId<"caseLawSource">;
  input: IngestionResult;
  observation: { order: bigint; observedAt: Date };
  errorType: string;
  errorMessage: string;
  recordIdentity?: string;
};

/** A review park uses the same atomic ledger and replay-input owner as a rejected batch item. */
export const parkIngestionFailureTx = async (
  tx: Transaction,
  {
    sourceId,
    input,
    observation,
    errorType,
    errorMessage,
    recordIdentity,
  }: ParkIngestionFailureOptions,
): Promise<Result<void, IngestionFailureEvidenceError>> => {
  const captured = captureFailureEvidence({
    record: { type: "decision", decision: input },
    observation,
  });
  if (Result.isError(captured)) {
    return Result.err(
      new IngestionFailureEvidenceError({
        message: "Cannot retain the failed source input",
        reason: "capture",
        cause: captured.error,
      }),
    );
  }
  const identity = ingestionFailureRecordIdentity({
    sourceDocumentId: input.sourceDocumentId,
    recordIdentity,
    replayEvidence: captured.value,
  });
  if (identity === undefined) {
    return Result.err(
      new IngestionFailureEvidenceError({
        message: "Failed source input has no valid replay identity",
        reason: "unaddressable",
      }),
    );
  }
  const written = await writeIngestionFailureRowsTx(tx, [
    {
      sourceId,
      caseNumber: input.caseNumber,
      language: input.language,
      errorType,
      errorMessage,
      ...identity,
      replayEvidence: captured.value,
    },
  ]);
  if (written.type !== "written") {
    return panic("A captured and identified failure was not replayable");
  }
  return Result.ok(undefined);
};
