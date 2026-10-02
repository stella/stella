import { panic, Result, TaggedError } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import { initialBatchState, type BatchState } from "@stll/db-load-gate/health";
import { DAY_IN_MS } from "@stll/time";

import { decodeCheckpoint } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawIndexJobs,
  databaseBackfillStates,
  euCompletionApprovals,
  euCompletionControls,
  euCompletionReceipts,
  euCompletionRequestHours,
  EU_COMPLETION_PAYLOAD_MAX_BYTES,
  EU_COMPLETION_REQUESTS_PER_HOUR,
  type EuCompletionProvenance,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";

export type EuCompletionReceipt = typeof euCompletionReceipts.$inferSelect;
export type EuCompletionMode = EuCompletionReceipt["mode"];
export type EuCompletionTerminalStatus =
  | "applied"
  | "unchanged"
  | "review-required"
  | "dry-run"
  | "too-large"
  | "publisher-gone";
const ACTIVE = [
  "pending",
  "fetched",
  "failed-backoff",
  "publisher-refused",
  "superseded-by-crawl",
] as const;
const TERMINAL = [
  "applied",
  "unchanged",
  "review-required",
  "dry-run",
  "failed",
  "too-large",
  "publisher-gone",
] as const;
export const EU_COMPLETION_STORE_LIMITS = {
  maxRows: 100,
  maxAttempts: 5,
  retryBaseMs: 60_000,
  retryMaxMs: 3_600_000,
  readmissionDays: 7,
  retentionDays: 90,
  isolationThreshold: 3,
} as const;
const QUIESCENT = [
  "applied",
  "unchanged",
  "review-required",
  "publisher-gone",
  "too-large",
] as const;
export class CompletionPayloadTooLarge extends TaggedError(
  "CompletionPayloadTooLarge",
)<{ message: string }> {}
export class CompletionApprovalError extends TaggedError(
  "CompletionApprovalError",
)<{
  message: string;
  code:
    | "not-found"
    | "invalid-proof"
    | "invalid-input"
    | "already-approved"
    | "database";
  cause?: unknown;
}> {}
export const euCompletionDecisionNotWithdrawn = (
  decisionId: SQLWrapper = caseLawDecisions.id,
) =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM ${caseLawIndexJobs} WHERE ${caseLawIndexJobs.decisionId} = ${decisionId} AND ${caseLawIndexJobs.operation} = 'withdraw' AND ${caseLawIndexJobs.status} = 'succeeded' LIMIT 1)`;
const GLOBAL_CONTROL = "global";
const sourceControl = (sourceId: EuCompletionReceipt["sourceId"]) =>
  `source:${sourceId}`;
const checkpointName = ({
  sourceId,
  mode,
  parserVersion,
}: Pick<EuCompletionReserveOptions, "sourceId" | "mode" | "parserVersion">) =>
  `eu-completion:${sourceId}:${mode}:${parserVersion}`;
const retryDelay = (attempts: number) =>
  Math.min(
    EU_COMPLETION_STORE_LIMITS.retryMaxMs,
    EU_COMPLETION_STORE_LIMITS.retryBaseMs *
      2 ** Math.min(16, Math.max(0, attempts - 1)),
  );
const validateLimit = (limit: number) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > EU_COMPLETION_STORE_LIMITS.maxRows
  ) {
    panic("Completion row limit must be bounded");
  }
};

export type EuCompletionReserveOptions = {
  sourceId: EuCompletionReceipt["sourceId"];
  mode: EuCompletionMode;
  parserVersion: number;
  limit: number;
};
type EuCompletionStoreOptions = {
  db: CaseLawRootHandle;
  cleanupDb?: CaseLawRootHandle;
  now: () => number;
};
type MarkFetchedOptions = {
  id: string;
  payload: string;
  payloadHash: string;
  claimedFingerprint: string;
  target: NonNullable<EuCompletionReceipt["target"]>;
  provenance: EuCompletionProvenance;
};
type FinishOptions = {
  id: string;
  status:
    | EuCompletionTerminalStatus
    | "publisher-refused"
    | "failed-backoff"
    | "superseded-by-crawl";
  retryAt?: Date;
  detail?: string;
};
export type EuCompletionFailure = {
  scope: "row" | "systemic";
  code:
    | "timeout"
    | "publisher"
    | "storage"
    | "parse"
    | "write"
    | "cancelled"
    | "unexpected";
  healthyEvidence: "adjacent-row" | "none";
  detail?: string;
  retryAt?: Date;
};
type ApprovalScope = Pick<
  EuCompletionReserveOptions,
  "sourceId" | "parserVersion"
>;
type ApproveOptions = Omit<
  typeof euCompletionApprovals.$inferInsert,
  "proofMode" | "proofStatus" | "proofCompletedAt"
>;
type SettleOptions = Omit<FinishOptions, "status"> & {
  status: FinishOptions["status"] | "pending" | "fetched";
};
type ControlOptions = {
  sourceId: EuCompletionReceipt["sourceId"] | null;
  state: "on" | "off";
  changedBy: string;
  changedAt: Date;
};

const boundedTransaction = async <T>(
  db: CaseLawRootHandle,
  work: (tx: Transaction) => Promise<T>,
) =>
  await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, 5000);
    await setSharedLockTimeout(tx, 1000);
    return await work(tx);
  });
const receiptTx = async (tx: Transaction, id: string) =>
  (
    await tx
      .select()
      .from(euCompletionReceipts)
      .where(eq(euCompletionReceipts.id, id))
      .for("update")
      .limit(1)
  ).at(0) ?? panic("Completion receipt does not exist");
const controlsTx = async (
  tx: Transaction,
  sourceId: EuCompletionReceipt["sourceId"],
) => {
  const rows = await tx
    .select()
    .from(euCompletionControls)
    .where(
      inArray(euCompletionControls.key, [
        GLOBAL_CONTROL,
        sourceControl(sourceId),
      ]),
    )
    .orderBy(asc(euCompletionControls.key))
    .for("share")
    .limit(2);
  return {
    global: rows.find((row) => row.key === GLOBAL_CONTROL)?.state ?? "off",
    source:
      rows.find((row) => row.key === sourceControl(sourceId))?.state ?? "off",
  };
};
const approvalTx = async (
  tx: Transaction,
  { sourceId, parserVersion }: ApprovalScope,
) =>
  (
    await tx
      .select()
      .from(euCompletionApprovals)
      .where(
        and(
          eq(euCompletionApprovals.sourceId, sourceId),
          eq(euCompletionApprovals.parserVersion, parserVersion),
        ),
      )
      .for("share")
      .limit(1)
  ).at(0) ?? null;
const verifyWrittenTx = async (
  tx: Transaction,
  receipt: EuCompletionReceipt,
): Promise<"applied" | "retryable" | "review-required"> => {
  if (receipt.writtenAt === null) {
    return "retryable";
  }
  const row = (
    await tx
      .select({
        sourceHash: caseLawDecisions.sourceHash,
        sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
        parserVersion: caseLawDecisions.parserVersion,
        redactedAt: caseLawDecisions.redactedAt,
        mirror: caseLawDecisions.corpusMirrorStatus,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, receipt.decisionId),
          euCompletionDecisionNotWithdrawn(),
        ),
      )
      .for("update")
      .limit(1)
  ).at(0);
  if (
    !row ||
    row.redactedAt !== null ||
    row.sourceHash !== receipt.writtenSourceHash ||
    row.sourceObservationOrder !== receipt.writtenObservationOrder ||
    row.parserVersion !== receipt.writtenParserVersion
  ) {
    return "review-required";
  }
  return row.mirror === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED
    ? "applied"
    : "retryable";
};

type ClassifyOptions = {
  receipt: EuCompletionReceipt;
  failure: EuCompletionFailure;
  progress: number;
};
const classifyFailure = ({ receipt, failure, progress }: ClassifyOptions) => {
  const sourceUnreachable =
    failure.code === "publisher" || failure.code === "timeout";
  const count =
    !sourceUnreachable &&
    receipt.attemptState !== "idle" &&
    failure.scope === "systemic" &&
    failure.code !== "cancelled";
  const baseline =
    receipt.systemicFailures === 0 ? progress : receipt.systemicProgress;
  const streak = count
    ? Math.min(
        EU_COMPLETION_STORE_LIMITS.isolationThreshold,
        receipt.systemicFailures + 1,
      )
    : receipt.systemicFailures;
  const isolated =
    count &&
    streak >= EU_COMPLETION_STORE_LIMITS.isolationThreshold &&
    (progress > baseline || failure.healthyEvidence === "adjacent-row");
  const failureScope = sourceUnreachable ? "systemic" : failure.scope;
  const scope = isolated ? "row" : failureScope;
  return {
    scope,
    isolated,
    attempts:
      scope === "systemic" && receipt.attemptState === "picked-up"
        ? Math.max(0, receipt.attempts - 1)
        : receipt.attempts +
          Number(scope === "row" && receipt.attemptState === "repair"),
    systemicFailures: isolated || sourceUnreachable ? 0 : streak,
    systemicProgress: isolated ? progress : baseline,
  };
};

const createStoreContext = ({
  db,
  cleanupDb = db,
  now,
}: EuCompletionStoreOptions) => ({
  now,
  transaction: async <T>(work: (tx: Transaction) => Promise<T>) =>
    await boundedTransaction(db, work),
  cleanup: async <T>(work: (tx: Transaction) => Promise<T>) =>
    await boundedTransaction(cleanupDb, work),
});
type StoreContext = ReturnType<typeof createStoreContext>;

const recordCompletionProgressTx = async (
  tx: Transaction,
  receipt: EuCompletionReceipt,
  { status, now }: { status: SettleOptions["status"]; now: () => number },
) => {
  const applied = status === "applied";
  const healthy =
    status === "applied" ||
    status === "dry-run" ||
    status === "unchanged" ||
    status === "review-required" ||
    status === "publisher-gone" ||
    status === "too-large";
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  await tx
    .insert(euCompletionControls)
    .values({
      key: sourceControl(receipt.sourceId),
      sourceId: receipt.sourceId,
      cursor: receipt.decisionId,
      completedRows: Number(applied),
      lastCompletedAt: applied ? new Date(now()) : null,
    })
    .onConflictDoUpdate({
      target: euCompletionControls.key,
      set: {
        cursor: receipt.decisionId,
        completedRows: sql`${euCompletionControls.completedRows} + ${Number(applied)}`,
        ...(healthy
          ? { batch: initialBatchState(), ticksWithoutProgress: 0 }
          : {}),
        ...(applied
          ? {
              ticksWithoutProgress: 0,
              batch: initialBatchState(),
              lastCompletedAt: new Date(now()),
            }
          : {}),
      },
    });
};

type RetireReceiptsOptions = {
  receipt: EuCompletionReceipt;
  status: EuCompletionReceipt["status"];
};
const retireCompletedReceiptsTx = async (
  tx: Transaction,
  { receipt, status }: RetireReceiptsOptions,
) => {
  const older = tx
    .select({ id: euCompletionReceipts.id })
    .from(euCompletionReceipts)
    .where(
      and(
        eq(euCompletionReceipts.sourceId, receipt.sourceId),
        eq(euCompletionReceipts.decisionId, receipt.decisionId),
        inArray(euCompletionReceipts.status, TERMINAL),
        isNotNull(euCompletionReceipts.completedAt),
        isNull(euCompletionReceipts.supersededAt),
        sql`(${euCompletionReceipts.createdAt}, ${euCompletionReceipts.id}) < (SELECT newer.created_at, newer.id FROM eu_completion_receipts newer WHERE newer.id = ${receipt.id} LIMIT 1)`,
        status === "applied"
          ? undefined
          : sql`${euCompletionReceipts.status} <> 'applied'`,
      ),
    )
    .orderBy(asc(euCompletionReceipts.createdAt), asc(euCompletionReceipts.id))
    .limit(EU_COMPLETION_STORE_LIMITS.maxRows);
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  await tx
    .update(euCompletionReceipts)
    .set({
      supersededAt: sql`(SELECT newer.completed_at FROM eu_completion_receipts newer WHERE newer.id = ${receipt.id} LIMIT 1)`,
    })
    .where(inArray(euCompletionReceipts.id, older));
};

type PublisherHoldOptions = {
  receipt: EuCompletionReceipt;
  retryAt: Date;
  now: () => number;
};
const holdPublisherRefusalTx = async (
  tx: Transaction,
  { receipt, retryAt, now }: PublisherHoldOptions,
) => {
  const control = (
    await tx
      .select()
      .from(euCompletionControls)
      .where(eq(euCompletionControls.key, sourceControl(receipt.sourceId)))
      .limit(1)
  ).at(0);
  const batch =
    control === undefined || control.batch === null
      ? initialBatchState()
      : decodeCheckpoint({ cursor: control.cursor, batch: control.batch })
          .batch;
  const held = {
    ...batch,
    holdCause: "other" as const,
    heldSince: batch.heldSince ?? now(),
    holdUntil: Math.max(batch.holdUntil ?? 0, retryAt.getTime()),
    holdCount: batch.holdCount + 1,
  };
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  await tx
    .insert(euCompletionControls)
    .values({
      key: sourceControl(receipt.sourceId),
      sourceId: receipt.sourceId,
      batch: held,
    })
    .onConflictDoUpdate({
      target: euCompletionControls.key,
      set: { batch: held },
    });
};

type ReceiptTransitionOptions = {
  receipt: EuCompletionReceipt;
  settlement: SettleOptions;
  decision:
    | {
        sourceHash: EuCompletionReceipt["claimedSourceHash"];
        observationOrder: EuCompletionReceipt["claimedObservationOrder"];
      }
    | undefined;
  at: Date;
};
const receiptTransition = ({
  receipt,
  settlement: { status, retryAt, detail },
  decision,
  at,
}: ReceiptTransitionOptions) => {
  const released = status === "pending" || status === "fetched";
  const superseded = status === "superseded-by-crawl";
  const retrying =
    status === "failed-backoff" || status === "publisher-refused" || superseded;
  return {
    status,
    detail: detail?.slice(0, 512) ?? null,
    retryAt: retrying || released ? (retryAt ?? null) : null,
    completionSourceHash:
      retrying || released ? null : (decision?.sourceHash ?? null),
    attempts:
      (status === "publisher-refused" || superseded || released) &&
      receipt.attemptState === "picked-up"
        ? Math.max(0, receipt.attempts - 1)
        : receipt.attempts,
    attemptState: "idle" as const,
    updatedAt: at,
    completedAt: retrying || released ? null : at,
    ...(retrying || released ? {} : { payload: null }),
    ...(superseded
      ? {
          claimedSourceHash: decision?.sourceHash ?? null,
          claimedObservationOrder: decision?.observationOrder ?? null,
          claimedFingerprint: null,
          payload: null,
          payloadHash: null,
          provenance: null,
          target: null,
          writtenAt: null,
          writtenSourceHash: null,
          writtenObservationOrder: null,
          writtenParserVersion: null,
        }
      : {}),
  };
};

const createSettlementOperations = ({ transaction, now }: StoreContext) => {
  const finishTx = async (
    tx: Transaction,
    { id, status, retryAt, detail }: SettleOptions,
  ) => {
    const receipt = await receiptTx(tx, id);
    if (!ACTIVE.some((activeStatus) => activeStatus === receipt.status)) {
      return null;
    }
    if (
      status === "applied" &&
      (receipt.mode !== "apply" ||
        (await verifyWrittenTx(tx, receipt)) !== "applied")
    ) {
      panic("Completion apply requires a verified settled canonical write");
    }
    if (
      status === "dry-run" &&
      (receipt.mode !== "dry-run" || receipt.status !== "fetched")
    ) {
      panic("Completion dry-run cannot settle apply work");
    }
    const retrying =
      status === "failed-backoff" ||
      status === "publisher-refused" ||
      status === "superseded-by-crawl";
    const decision = (
      await tx
        .select({
          sourceHash: caseLawDecisions.sourceHash,
          observationOrder: caseLawDecisions.sourceObservationOrder,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, receipt.decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (
      (retrying && retryAt === undefined) ||
      (retryAt !== undefined &&
        (!Number.isFinite(retryAt.getTime()) || retryAt.getTime() <= now()))
    ) {
      panic("Completion backoff requires a future time");
    }
    // audit: skip — public case-law corpus bookkeeping, no workspace data
    const settled =
      (
        await tx
          .update(euCompletionReceipts)
          .set(
            receiptTransition({
              receipt,
              settlement: { id, status, retryAt, detail },
              decision,
              at: new Date(now()),
            }),
          )
          .where(eq(euCompletionReceipts.id, id))
          .returning()
      ).at(0) ?? panic("Completion locked receipt disappeared");
    if (status === "publisher-refused" && retryAt !== undefined) {
      await holdPublisherRefusalTx(tx, { receipt, retryAt, now });
    }
    if (settled.completedAt !== null) {
      await retireCompletedReceiptsTx(tx, {
        receipt: settled,
        status: settled.status,
      });
    }
    await recordCompletionProgressTx(tx, receipt, { status, now });
    return settled;
  };
  const assertApprovalTx = async (tx: Transaction, scope: ApprovalScope) => {
    const controls = await controlsTx(tx, scope.sourceId);
    return (
      controls.global === "on" &&
      controls.source === "on" &&
      (await approvalTx(tx, scope)) !== null
    );
  };
  const assertFetchedTx = async (tx: Transaction, id: string) => {
    const receipt = await receiptTx(tx, id);
    return receipt.status === "fetched" ? receipt : null;
  };
  const markWrittenTx = async (
    tx: Transaction,
    {
      id,
      decisionId,
    }: { id: string; decisionId: EuCompletionReceipt["decisionId"] },
  ) => {
    const receipt = await receiptTx(tx, id);
    if (
      receipt.status !== "fetched" ||
      receipt.mode !== "apply" ||
      receipt.decisionId !== decisionId
    ) {
      panic("Completion canonical write has no matching fetched apply receipt");
    }
    if (!(await assertApprovalTx(tx, receipt))) {
      panic("Completion canonical write lacks enabled supervised approval");
    }
    const row = (
      await tx
        .select({
          sourceHash: caseLawDecisions.sourceHash,
          sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
          parserVersion: caseLawDecisions.parserVersion,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (
      !row ||
      row.sourceHash === null ||
      row.parserVersion === null ||
      row.sourceObservationOrder === null
    ) {
      panic(
        "Completion canonical write requires its persisted hash and parser stamp",
      );
    }
    // audit: skip — public case-law corpus bookkeeping, no workspace data
    await tx
      .update(euCompletionReceipts)
      .set({
        writtenAt: new Date(now()),
        writtenSourceHash: row.sourceHash,
        writtenObservationOrder: row.sourceObservationOrder,
        writtenParserVersion: row.parserVersion,
        updatedAt: new Date(now()),
      })
      .where(eq(euCompletionReceipts.id, id));
  };
  const finalize = async (id: string) =>
    await transaction(async (tx) => {
      const receipt = await receiptTx(tx, id);
      if (
        receipt.status === "applied" ||
        receipt.status === "review-required"
      ) {
        return receipt.status;
      }
      const disposition = await verifyWrittenTx(tx, receipt);
      if (disposition !== "retryable") {
        await finishTx(tx, { id, status: disposition });
      }
      return disposition;
    });
  return {
    finishTx,
    assertApprovalTx,
    assertFetchedTx,
    markWrittenTx,
    finalize,
  };
};

const createReservationOperations = ({ transaction, now }: StoreContext) => {
  const reserve = async (options: EuCompletionReserveOptions) => {
    const { sourceId, mode, parserVersion, limit } = options;
    validateLimit(limit);
    if (!Number.isSafeInteger(parserVersion) || parserVersion < 0) {
      panic("Completion parser version is invalid");
    }
    return await transaction(async (tx) => {
      const name = checkpointName(options);
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .insert(databaseBackfillStates)
        .values({ name, batch: initialBatchState() })
        .onConflictDoNothing();
      const state =
        (
          await tx
            .select()
            .from(databaseBackfillStates)
            .where(eq(databaseBackfillStates.name, name))
            .for("update")
            .limit(1)
        ).at(0) ?? panic("Completion checkpoint was not created");
      const cursor = (
        await tx
          .select({ cursor: euCompletionControls.cursor })
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, sourceControl(sourceId)))
          .limit(1)
      ).at(0)?.cursor;
      const due = await tx
        .select()
        .from(euCompletionReceipts)
        .where(
          and(
            eq(euCompletionReceipts.sourceId, sourceId),
            eq(euCompletionReceipts.mode, mode),
            eq(euCompletionReceipts.parserVersion, parserVersion),
            inArray(euCompletionReceipts.status, [...ACTIVE, "failed"]),
            euCompletionDecisionNotWithdrawn(euCompletionReceipts.decisionId),
            or(
              isNull(euCompletionReceipts.retryAt),
              lte(
                euCompletionReceipts.retryAt,
                sql`${new Date(now())}::timestamptz`,
              ),
            ),
          ),
        )
        .orderBy(
          ...(cursor
            ? [
                sql`CASE WHEN ${euCompletionReceipts.decisionId} > ${cursor}::uuid THEN 0 ELSE 1 END`,
              ]
            : []),
          asc(euCompletionReceipts.decisionId),
          asc(euCompletionReceipts.id),
        )
        .limit(limit);
      if (due.length > 0) {
        return due;
      }
      const pageQuery = (after: string | null) =>
        tx
          .select({
            id: caseLawDecisions.id,
            sourceHash: caseLawDecisions.sourceHash,
            sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              isNull(caseLawDecisions.redactedAt),
              euCompletionDecisionNotWithdrawn(),
              notExists(
                tx
                  .select({ id: euCompletionReceipts.id })
                  .from(euCompletionReceipts)
                  .where(
                    and(
                      eq(euCompletionReceipts.sourceId, sourceId),
                      eq(euCompletionReceipts.decisionId, caseLawDecisions.id),
                      eq(euCompletionReceipts.mode, mode),
                      eq(euCompletionReceipts.parserVersion, parserVersion),
                      inArray(euCompletionReceipts.status, QUIESCENT),
                      sql`${euCompletionReceipts.completionSourceHash} IS NOT DISTINCT FROM ${caseLawDecisions.sourceHash}`,
                    ),
                  ),
              ),
              after === null
                ? undefined
                : gt(caseLawDecisions.id, sql`${after}::uuid`),
              notExists(
                tx
                  .select({ id: euCompletionReceipts.id })
                  .from(euCompletionReceipts)
                  .where(
                    and(
                      eq(euCompletionReceipts.sourceId, sourceId),
                      eq(euCompletionReceipts.decisionId, caseLawDecisions.id),
                      eq(euCompletionReceipts.mode, mode),
                      eq(euCompletionReceipts.parserVersion, parserVersion),
                      inArray(euCompletionReceipts.status, [
                        ...ACTIVE,
                        "failed",
                      ]),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(caseLawDecisions.id))
          .limit(limit);
      let page = await pageQuery(state.cursor);
      if (page.length === 0 && state.cursor !== null) {
        page = await pageQuery(null);
      }
      if (page.length === 0) {
        return [];
      }
      // Event identity remains stable across recovery; distinct target attempts
      // retain distinct identities even before their target can be classified.
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      const rows = await tx
        .insert(euCompletionReceipts)
        .values(
          page.map((row) => ({
            id: Bun.randomUUIDv7(),
            sourceId,
            decisionId: row.id,
            mode,
            parserVersion,
            status: "pending" as const,
            claimedSourceHash: row.sourceHash,
            claimedObservationOrder: row.sourceObservationOrder,
            createdAt: new Date(now()),
            updatedAt: new Date(now()),
          })),
        )
        .returning();
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      const advanced = await tx
        .update(databaseBackfillStates)
        .set({
          cursor:
            page.at(-1)?.id ?? panic("Completion page unexpectedly empty"),
          updatedAt: new Date(now()),
        })
        .where(
          and(
            eq(databaseBackfillStates.name, name),
            state.cursor === null
              ? isNull(databaseBackfillStates.cursor)
              : eq(databaseBackfillStates.cursor, state.cursor),
          ),
        )
        .returning();
      if (advanced.length !== 1) {
        panic("Completion checkpoint CAS failed under lock");
      }
      return rows;
    });
  };
  return { reserve };
};

const createPayloadOperations = ({ transaction, now }: StoreContext) => {
  const markFetched = async ({
    id,
    payload,
    payloadHash,
    claimedFingerprint,
    target,
    provenance,
  }: MarkFetchedOptions) => {
    if (Buffer.byteLength(payload, "utf-8") > EU_COMPLETION_PAYLOAD_MAX_BYTES) {
      return Result.err(
        new CompletionPayloadTooLarge({
          message: "Completion recovery payload exceeds the row byte limit",
        }),
      );
    }
    if (
      new Bun.CryptoHasher("sha256").update(payload).digest("hex") !==
        payloadHash ||
      !payloadHash ||
      !claimedFingerprint ||
      provenance.requestHashes.length > 100 ||
      provenance.requestedSurfaces.length > 100 ||
      Buffer.byteLength(JSON.stringify(provenance), "utf-8") > 32_768
    ) {
      panic("Completion fetched envelope exceeds recovery bounds");
    }
    return Result.ok(
      await transaction(async (tx) => {
        const receipt = await receiptTx(tx, id);
        if (receipt.target !== null && receipt.target !== target) {
          panic("Completion receipt target is immutable");
        }
        if (
          receipt.status !== "pending" &&
          receipt.status !== "failed-backoff"
        ) {
          return null;
        }
        // audit: skip — public case-law corpus bookkeeping, no workspace data
        return (
          (
            await tx
              .update(euCompletionReceipts)
              .set({
                status: "fetched",
                payload,
                payloadHash,
                claimedFingerprint,
                target,
                provenance,
                updatedAt: new Date(now()),
              })
              .where(eq(euCompletionReceipts.id, id))
              .returning()
          ).at(0) ?? null
        );
      }),
    );
  };
  const pickup = async (id: string): Promise<"ready" | "waiting" | "failed"> =>
    await transaction(async (tx) => {
      const receipt = await receiptTx(tx, id);
      if (receipt.retryAt !== null && receipt.retryAt.getTime() > now()) {
        return "waiting";
      }
      if (
        !ACTIVE.some((status) => status === receipt.status) &&
        receipt.status !== "failed"
      ) {
        return "waiting";
      }
      const attempts = receipt.status === "failed" ? 0 : receipt.attempts;
      const pickedState = receipt.writtenAt === null ? "picked-up" : "repair";
      const exhausted =
        attempts >= EU_COMPLETION_STORE_LIMITS.maxAttempts &&
        receipt.writtenAt === null;
      const resumedStatus = receipt.payload === null ? "pending" : "fetched";
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .update(euCompletionReceipts)
        .set({
          attempts: exhausted
            ? attempts
            : attempts + Number(receipt.writtenAt === null),
          attemptState: exhausted ? "idle" : pickedState,
          systemicFailures:
            receipt.status === "failed" ? 0 : receipt.systemicFailures,
          status: exhausted ? "failed" : resumedStatus,
          retryAt: new Date(
            now() +
              (exhausted
                ? EU_COMPLETION_STORE_LIMITS.readmissionDays * DAY_IN_MS
                : retryDelay(attempts + 1)),
          ),
          completedAt: exhausted ? new Date(now()) : null,
          updatedAt: new Date(now()),
        })
        .where(eq(euCompletionReceipts.id, id));
      return exhausted ? "failed" : "ready";
    });
  return { markFetched, pickup };
};

const createFailureOperations = (
  { cleanup, now }: StoreContext,
  { finishTx }: Pick<ReturnType<typeof createSettlementOperations>, "finishTx">,
) => {
  const recordFailure = async (
    receipt: EuCompletionReceipt,
    failure: EuCompletionFailure,
  ): Promise<"retryable" | "failed" | "isolated" | "applied"> =>
    await cleanup(async (tx) => {
      const current = await receiptTx(tx, receipt.id);
      if (!ACTIVE.some((status) => status === current.status)) {
        return current.status === "applied" ? "applied" : "failed";
      }
      if (failure.code === "cancelled") {
        await finishTx(tx, {
          id: current.id,
          status: current.payload === null ? "pending" : "fetched",
        });
        return "retryable";
      }
      const verified = await verifyWrittenTx(tx, current);
      if (verified === "applied") {
        await finishTx(tx, { id: current.id, status: "applied" });
        return "applied";
      }
      if (verified === "review-required") {
        await finishTx(tx, { id: current.id, status: "review-required" });
        return "failed";
      }
      const control = (
        await tx
          .select()
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, sourceControl(receipt.sourceId)))
          .for("update")
          .limit(1)
      ).at(0);
      const classification = classifyFailure({
        receipt: current,
        failure,
        progress: control?.completedRows ?? 0,
      });
      const exhausted =
        classification.scope === "row" &&
        classification.attempts >= EU_COMPLETION_STORE_LIMITS.maxAttempts;
      const batch =
        control?.batch === null || control === undefined
          ? initialBatchState()
          : decodeCheckpoint({ cursor: control.cursor, batch: control.batch })
              .batch;
      const held =
        classification.scope === "systemic"
          ? {
              ...batch,
              holdCause: "other" as const,
              heldSince: batch.heldSince ?? now(),
              holdUntil: Math.max(
                failure.retryAt?.getTime() ?? 0,
                now() + retryDelay(batch.holdCount + 1),
              ),
              holdCount: batch.holdCount + 1,
            }
          : batch;
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .update(euCompletionReceipts)
        .set({
          attempts: classification.attempts,
          systemicFailures: classification.systemicFailures,
          systemicProgress: classification.systemicProgress,
          attemptState: "idle",
          status: exhausted ? "failed" : "failed-backoff",
          detail: failure.detail?.slice(0, 512) ?? failure.code,
          retryAt: new Date(
            Math.max(
              failure.retryAt?.getTime() ?? 0,
              now() +
                (exhausted
                  ? EU_COMPLETION_STORE_LIMITS.readmissionDays * DAY_IN_MS
                  : retryDelay(classification.attempts)),
            ),
          ),
          completedAt: exhausted ? new Date(now()) : null,
          updatedAt: new Date(now()),
        })
        .where(eq(euCompletionReceipts.id, receipt.id));
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .insert(euCompletionControls)
        .values({
          key: sourceControl(receipt.sourceId),
          sourceId: receipt.sourceId,
          cursor: receipt.decisionId,
          batch: held,
        })
        .onConflictDoUpdate({
          target: euCompletionControls.key,
          set: { cursor: receipt.decisionId, batch: held },
        });
      if (exhausted) {
        await retireCompletedReceiptsTx(tx, {
          receipt: current,
          status: "failed",
        });
        return "failed";
      }
      return classification.isolated ? "isolated" : "retryable";
    });
  return { recordFailure };
};

const createRetentionOperations = ({ transaction, now }: StoreContext) => {
  const reserveRequest = async ({
    hour,
  }: {
    sourceId: EuCompletionReceipt["sourceId"];
    hour: Date | string;
  }) => {
    const value = new Date(hour);
    if (
      !Number.isFinite(value.getTime()) ||
      value.getTime() % 3_600_000 !== 0
    ) {
      panic("Completion request budget requires a UTC hour boundary");
    }
    return await transaction(
      async (tx) =>
        // audit: skip — public case-law corpus bookkeeping, no workspace data
        (
          await tx
            .insert(euCompletionRequestHours)
            .values({ hour: value, requests: 1 })
            .onConflictDoUpdate({
              target: euCompletionRequestHours.hour,
              set: { requests: sql`${euCompletionRequestHours.requests} + 1` },
              setWhere: sql`${euCompletionRequestHours.requests} < ${EU_COMPLETION_REQUESTS_PER_HOUR}`,
            })
            .returning()
        ).length === 1,
    );
  };
  const compact = async ({ limit }: { limit: number }) => {
    validateLimit(limit);
    return await transaction(async (tx) => {
      const old = await tx
        .select({ id: euCompletionReceipts.id })
        .from(euCompletionReceipts)
        .where(
          and(
            isNotNull(euCompletionReceipts.supersededAt),
            lte(
              euCompletionReceipts.supersededAt,
              sql`${new Date(now() - EU_COMPLETION_STORE_LIMITS.retentionDays * DAY_IN_MS)}::timestamptz`,
            ),
            inArray(euCompletionReceipts.status, TERMINAL),
            sql`NOT EXISTS (SELECT 1 FROM eu_completion_receipts protected WHERE protected.id = ${euCompletionReceipts.id} AND protected.status = 'applied' AND NOT EXISTS (SELECT 1 FROM eu_completion_receipts newer WHERE newer.source_id = protected.source_id AND newer.decision_id = protected.decision_id AND newer.status = 'applied' AND newer.completed_at IS NOT NULL AND (newer.created_at, newer.id) > (protected.created_at, protected.id) LIMIT 1) LIMIT 1)`,
            notExists(
              tx
                .select({ id: euCompletionApprovals.supervisedReceiptId })
                .from(euCompletionApprovals)
                .where(
                  eq(
                    euCompletionApprovals.supervisedReceiptId,
                    euCompletionReceipts.id,
                  ),
                ),
            ),
          ),
        )
        .orderBy(
          asc(euCompletionReceipts.supersededAt),
          asc(euCompletionReceipts.id),
        )
        .limit(limit)
        .for("update");
      const expiredHours = tx
        .select({ hour: euCompletionRequestHours.hour })
        .from(euCompletionRequestHours)
        .where(
          lt(
            euCompletionRequestHours.hour,
            sql`${new Date(now() - EU_COMPLETION_STORE_LIMITS.retentionDays * DAY_IN_MS)}::timestamptz`,
          ),
        )
        .orderBy(asc(euCompletionRequestHours.hour))
        .limit(limit);
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .delete(euCompletionRequestHours)
        .where(inArray(euCompletionRequestHours.hour, expiredHours));
      if (old.length === 0) {
        return 0;
      }
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      return (
        await tx
          .delete(euCompletionReceipts)
          .where(
            inArray(
              euCompletionReceipts.id,
              old.map(({ id }) => id),
            ),
          )
          .returning()
      ).length;
    });
  };
  return { reserveRequest, compact };
};

const createApprovalOperations = ({ transaction, now }: StoreContext) => {
  const getApproval = async (scope: ApprovalScope) =>
    await transaction(async (tx) => await approvalTx(tx, scope));
  const approveSupervisedDryRun = async (approval: ApproveOptions) => {
    const attempted = await Result.tryPromise({
      try: async () =>
        await transaction(async (tx) => {
          const receipt = (
            await tx
              .select()
              .from(euCompletionReceipts)
              .where(eq(euCompletionReceipts.id, approval.supervisedReceiptId))
              .for("update")
              .limit(1)
          ).at(0);
          if (receipt === undefined)
            {return Result.err(
              new CompletionApprovalError({
                code: "not-found",
                message: "The supervised receipt does not exist",
              }),
            );}
          const counts = approval.reviewedCounts;
          if (
            Object.values(counts).some(
              (count) =>
                !Number.isSafeInteger(count) || count < 0 || count > 1_000_000,
            ) ||
            counts.reviewed < 1 ||
            counts.accepted + counts.requiresReview !== counts.reviewed ||
            !Number.isFinite(approval.approvedAt.getTime()) ||
            !Number.isFinite(approval.supervisedAt.getTime()) ||
            approval.approvedAt.getTime() > now() ||
            approval.supervisedAt.getTime() > approval.approvedAt.getTime() ||
            !approval.evidenceRef.trim() ||
            approval.evidenceRef.length > 2048 ||
            !approval.supervisedBy.trim() ||
            approval.supervisedBy.length > 128 ||
            !approval.approvedBy.trim() ||
            approval.approvedBy.length > 128
          )
            {return Result.err(
              new CompletionApprovalError({
                code: "invalid-input",
                message:
                  "Approval requires attributed times, evidence and bounded reviewed counts",
              }),
            );}
          if (
            receipt.status !== "dry-run" ||
            receipt.mode !== "dry-run" ||
            receipt.completedAt === null ||
            receipt.sourceId !== approval.sourceId ||
            receipt.parserVersion !== approval.parserVersion ||
            approval.supervisedAt.getTime() < receipt.completedAt.getTime()
          )
            {return Result.err(
              new CompletionApprovalError({
                code: "invalid-proof",
                message:
                  "Approval must reference a completed dry-run receipt for the same source and parser, supervised after completion",
              }),
            );}
          // audit: skip — public case-law corpus bookkeeping, no workspace data
          const rows = await tx
            .insert(euCompletionApprovals)
            .values({
              ...approval,
              proofMode: "dry-run",
              proofStatus: "dry-run",
              proofCompletedAt: sql`(SELECT ${euCompletionReceipts.completedAt} FROM ${euCompletionReceipts} WHERE ${euCompletionReceipts.id} = ${receipt.id} LIMIT 1)`,
            })
            .onConflictDoNothing()
            .returning();
          const approved = rows.at(0);
          if (approved === undefined)
            {return Result.err(
              new CompletionApprovalError({
                code: "already-approved",
                message:
                  "This source and parser generation already has supervised approval",
              }),
            );}
          return Result.ok(approved);
        }),
      catch: (cause) =>
        new CompletionApprovalError({
          code: "database",
          message: "Supervised approval could not be persisted",
          cause,
        }),
    });
    return attempted.andThen((result) => result);
  };
  const setControl = async ({
    sourceId,
    state,
    changedBy,
    changedAt,
  }: ControlOptions) => {
    if (
      !changedBy.trim() ||
      changedBy.length > 128 ||
      !Number.isFinite(changedAt.getTime()) ||
      changedAt.getTime() > now()
    ) {
      panic("Completion control requires explicit operator attribution");
    }
    return await transaction(async (tx) => {
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .insert(euCompletionControls)
        .values({
          key: sourceId === null ? GLOBAL_CONTROL : sourceControl(sourceId),
          sourceId,
          state,
          changedBy,
          changedAt,
        })
        .onConflictDoUpdate({
          target: euCompletionControls.key,
          set: { state, changedBy, changedAt },
        });
    });
  };
  return { getApproval, approveSupervisedDryRun, setControl };
};

const createGateOperations = ({ transaction, cleanup }: StoreContext) => {
  const loadPreflightGateState = async () =>
    await transaction(async (tx) => {
      const row = (
        await tx
          .select({ batch: euCompletionControls.batch })
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, GLOBAL_CONTROL))
          .limit(1)
      ).at(0);
      return row?.batch === null || row === undefined
        ? initialBatchState()
        : decodeCheckpoint({ cursor: null, batch: row.batch }).batch;
    });
  const loadSourceGateState = async (
    sourceId: EuCompletionReceipt["sourceId"],
  ) =>
    await transaction(async (tx) => {
      const row = (
        await tx
          .select()
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, sourceControl(sourceId)))
          .limit(1)
      ).at(0);
      return row === undefined || row.batch === null
        ? initialBatchState()
        : decodeCheckpoint({ cursor: row.cursor, batch: row.batch }).batch;
    });
  const savePreflightGateState = async (batch: BatchState) =>
    await cleanup(async (tx) => {
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      await tx
        .insert(euCompletionControls)
        .values({ key: GLOBAL_CONTROL, batch })
        .onConflictDoUpdate({
          target: euCompletionControls.key,
          set: { batch },
        });
    });
  const recordTick = async ({
    sourceId,
    mode,
    healthyCompleted,
    intentionallyHeld,
  }: {
    sourceId: EuCompletionReceipt["sourceId"];
    mode: EuCompletionMode;
    healthyCompleted: number;
    intentionallyHeld: boolean;
  }) =>
    await cleanup(async (tx) => {
      const madeProgress = healthyCompleted > 0;
      const shouldProgress = mode === "apply" && !intentionallyHeld;
      // Only verified settlement increments completedRows; caller metrics cannot
      // manufacture healthy evidence for systemic-failure isolation.
      // audit: skip — public case-law corpus bookkeeping, no workspace data
      const row = (
        await tx
          .insert(euCompletionControls)
          .values({
            key: sourceControl(sourceId),
            sourceId,
            ticksWithoutProgress: madeProgress || !shouldProgress ? 0 : 1,
          })
          .onConflictDoUpdate({
            target: euCompletionControls.key,
            set: {
              ticksWithoutProgress:
                madeProgress || mode === "dry-run"
                  ? 0
                  : sql`${euCompletionControls.ticksWithoutProgress} + ${Number(shouldProgress)}`,
            },
          })
          .returning({
            ticksWithoutProgress: euCompletionControls.ticksWithoutProgress,
            lastCompletedAt: euCompletionControls.lastCompletedAt,
          })
      ).at(0);
      return row ?? panic("Completion progress insert returned no row");
    });
  const readSweepCursor = async (
    scope: Pick<
      EuCompletionReserveOptions,
      "sourceId" | "mode" | "parserVersion"
    >,
  ) =>
    await transaction(
      async (tx) =>
        (
          await tx
            .select({ cursor: databaseBackfillStates.cursor })
            .from(databaseBackfillStates)
            .where(eq(databaseBackfillStates.name, checkpointName(scope)))
            .limit(1)
        ).at(0)?.cursor ?? null,
    );
  return {
    loadPreflightGateState,
    loadSourceGateState,
    savePreflightGateState,
    recordTick,
    readSweepCursor,
  };
};

const createProbeOperations = ({ transaction, now }: StoreContext) => {
  const probe = async ({
    sourceId,
    mode,
    parserVersion,
  }: ApprovalScope & { mode: EuCompletionMode }) =>
    await transaction(async (tx) => {
      const queued =
        (
          await tx
            .select({ id: euCompletionReceipts.id })
            .from(euCompletionReceipts)
            .where(
              and(
                eq(euCompletionReceipts.sourceId, sourceId),
                eq(euCompletionReceipts.mode, mode),
                eq(euCompletionReceipts.parserVersion, parserVersion),
                inArray(euCompletionReceipts.status, [...ACTIVE, "failed"]),
              ),
            )
            .limit(1)
        ).length > 0;
      let earliest: Date | null = null;
      for (const status of [
        "failed-backoff",
        "failed",
        "publisher-refused",
      ] as const) {
        const retry = (
          await tx
            .select({ retryAt: euCompletionReceipts.retryAt })
            .from(euCompletionReceipts)
            .where(
              and(
                eq(euCompletionReceipts.sourceId, sourceId),
                eq(euCompletionReceipts.mode, mode),
                eq(euCompletionReceipts.parserVersion, parserVersion),
                eq(euCompletionReceipts.status, status),
              ),
            )
            .orderBy(asc(euCompletionReceipts.retryAt))
            .limit(1)
        ).at(0)?.retryAt;
        if (
          retry &&
          (earliest === null || retry.getTime() < earliest.getTime())
        ) {
          earliest = retry;
        }
      }
      const progress = (
        await tx
          .select({
            lastCompletedAt: euCompletionControls.lastCompletedAt,
            batch: euCompletionControls.batch,
            cursor: euCompletionControls.cursor,
          })
          .from(euCompletionControls)
          .where(eq(euCompletionControls.key, sourceControl(sourceId)))
          .limit(1)
      ).at(0);
      const sourceBatch =
        progress === undefined || progress.batch === null
          ? null
          : decodeCheckpoint({ cursor: progress.cursor, batch: progress.batch })
              .batch;
      return {
        hasQueuedWork: queued,
        sourceBackoffAgeMs:
          sourceBatch === null || sourceBatch.heldSince === null
            ? null
            : Math.max(0, now() - sourceBatch.heldSince),
        oldestRetryAgeMs:
          earliest === null ? null : Math.max(0, now() - earliest.getTime()),
        lastCompletedAt: progress?.lastCompletedAt ?? null,
      };
    });
  return { probe };
};

export const createEuCompletionStore = (options: EuCompletionStoreOptions) => {
  const context = createStoreContext(options);
  const settlement = createSettlementOperations(context);
  return {
    ...settlement,
    releaseBenign: async (id: string, retryAt?: Date) =>
      await context.cleanup(async (tx) => {
        const receipt = await receiptTx(tx, id);
        return await settlement.finishTx(tx, {
          id,
          status: receipt.payload === null ? "pending" : "fetched",
          ...(retryAt === undefined ? {} : { retryAt }),
        });
      }),
    ...createReservationOperations(context),
    ...createPayloadOperations(context),
    ...createFailureOperations(context, settlement),
    ...createRetentionOperations(context),
    ...createApprovalOperations(context),
    ...createGateOperations(context),
    ...createProbeOperations(context),
    finish: async (finishOptions: FinishOptions) =>
      await context.cleanup(
        async (tx) => await settlement.finishTx(tx, finishOptions),
      ),
    loadControls: async (sourceId: EuCompletionReceipt["sourceId"]) =>
      await context.transaction(async (tx) => await controlsTx(tx, sourceId)),
    getReceipt: async (id: string) =>
      await context.transaction(async (tx) => await receiptTx(tx, id)),
  };
};
