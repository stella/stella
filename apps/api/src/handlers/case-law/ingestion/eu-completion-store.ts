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
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

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
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  permitsLifecycleMove,
  transitionLifecycle,
  transitionLifecycleBatch,
} from "@/api/lib/db/transitions";
import type { SystemAuditCounts } from "@/api/lib/system-audit/actors";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export type EuCompletionReceipt = typeof euCompletionReceipts.$inferSelect;
type EuCompletionMode = EuCompletionReceipt["mode"];
type EuCompletionTerminalStatus =
  | "applied"
  | "unchanged"
  | "review-required"
  | "dry-run"
  | "too-large"
  | "publisher-gone"
  | "withdrawn";
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
  "publisher-refused",
  "withdrawn",
] as const;
export const EU_COMPLETION_STORE_LIMITS = {
  maxRows: 100,
  maxAttempts: 5,
  retryBaseMs: 60_000,
  retryMaxMs: 3_600_000,
  readmissionDays: 7,
  retentionDays: 90,
  isolationThreshold: 3,
  refusalMinHoldMs: 3_600_000,
  refusalMaxHoldMs: 24 * 3_600_000,
  maxDocumentRefusals: 3,
  maxMirrorWaits: 3,
  mirrorWaitMs: 60_000,
} as const;

/** A publisher refusal holds completion at most `refusalMaxHoldMs` from now. */
export const capRefusalHold = (untilMs: number, nowMs: number) =>
  Math.min(untilMs, nowMs + EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs);
const QUIESCENT = [
  "dry-run",
  "publisher-refused",
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
  decisionId: SQLWrapper = sql`${caseLawDecisions}.${sql.identifier("id")}`,
) =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM ${caseLawIndexJobs} withdrawal JOIN ${caseLawDecisions} document ON document.id = withdrawal.decision_id WHERE withdrawal.decision_id = ${decisionId} AND withdrawal.operation = 'withdraw' AND withdrawal.status = 'succeeded' AND document.fulltext IS NULL AND document.document_ast IS NULL AND document.content_hash IS NULL AND document.text_s3_key IS NULL LIMIT 1)`;
const MIRROR_REPAIR_REQUIRED = "canonical mirror repair required";
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

type EuCompletionReserveOptions = {
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
  healthyEvidence?: EuCompletionFailure["healthyEvidence"];
  publisherSuccess?: boolean;
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
  mirrorWait?: "increment";
  refusal?: PublisherRefusalState;
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
const receiptIsActive = (receipt: EuCompletionReceipt) =>
  ACTIVE.some((status) => status === receipt.status) &&
  receipt.completedAt === null;
const receiptTx = async (tx: Transaction, id: string) =>
  (
    await tx
      .select()
      .from(euCompletionReceipts)
      .where(eq(euCompletionReceipts.id, id))
      .for("update")
      .limit(1)
  ).at(0) ?? panic("Completion receipt does not exist");
// Receipt and control transitions are attributed to the completion run's
// system audit row, which recordTick writes once per tick that changed anything.
const attributedToCompletionRun = async () => {
  await Promise.resolve();
};

type ReceiptMetadata = Omit<
  PgUpdateSetSource<typeof euCompletionReceipts>,
  "id" | "status" | "attemptState"
>;
type ReceiptMoveOptions = {
  receipt: EuCompletionReceipt;
  status: EuCompletionReceipt["status"];
  attemptState: EuCompletionReceipt["attemptState"];
  set: ReceiptMetadata;
};
/** Moves a receipt locked by receiptTx; both lifecycle columns move together. */
const moveReceiptTx = async (
  tx: Transaction,
  { receipt, status, attemptState, set }: ReceiptMoveOptions,
) => {
  const { graphs } = TRANSITIONS.euCompletionReceipts;
  const statusMove = { from: [receipt.status], to: status };
  const attemptMove = { from: [receipt.attemptState], to: attemptState };
  if (
    !permitsLifecycleMove(graphs.status, statusMove) ||
    !permitsLifecycleMove(graphs.attemptState, attemptMove)
  ) {
    panic(`Completion receipt cannot move from ${receipt.status} to ${status}`);
  }
  const moved = await transitionLifecycle({
    tx,
    spec: TRANSITIONS.euCompletionReceipts,
    id: receipt.id,
    moves: { status: statusMove, attemptState: attemptMove },
    set,
    recordTransitionAuditEvent: attributedToCompletionRun,
  });
  if (moved.type === "stale") {
    panic("Completion locked receipt changed under its lock");
  }
  return await receiptTx(tx, receipt.id);
};
const controlsTx = async (
  tx: Transaction,
  sourceId: EuCompletionReceipt["sourceId"],
) => {
  const keys = [GLOBAL_CONTROL, sourceControl(sourceId)];
  const rows = await tx
    .select()
    .from(euCompletionControls)
    .where(inArray(euCompletionControls.key, keys))
    .orderBy(asc(euCompletionControls.key))
    .for("share")
    .limit(keys.length + 1);
  if (rows.length > keys.length) {
    panic("Completion controls matched more rows than primary keys");
  }
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
  {
    status,
    now,
    mirrorWait,
    publisherSuccess,
  }: {
    publisherSuccess: boolean;
    status: SettleOptions["status"];
    now: () => number;
    mirrorWait?: SettleOptions["mirrorWait"];
  },
) => {
  const applied = status === "applied";
  const healthy =
    mirrorWait !== "increment" &&
    (status === "applied" ||
      status === "dry-run" ||
      status === "unchanged" ||
      status === "review-required" ||
      status === "publisher-gone" ||
      status === "too-large");
  await tx
    .insert(euCompletionControls)
    .values({
      key: sourceControl(receipt.sourceId),
      sourceId: receipt.sourceId,
      cursor: receipt.decisionId,
      completedRows: Number(applied),
      healthyRows: Number(healthy && publisherSuccess),
      lastCompletedAt: applied ? new Date(now()) : null,
    })
    .onConflictDoUpdate({
      target: euCompletionControls.key,
      set: {
        cursor: receipt.decisionId,
        completedRows: sql`${euCompletionControls.completedRows} + ${Number(applied)}`,
        healthyRows: sql`${euCompletionControls.healthyRows} + ${Number(healthy && publisherSuccess)}`,
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
    );
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
    control?.batch === undefined || control.batch === null
      ? initialBatchState()
      : decodeCheckpoint({ cursor: control.cursor, batch: control.batch })
          .batch;
  const currentTime = now();
  const held = {
    ...batch,
    holdCause: "other" as const,
    heldSince: batch.heldSince ?? currentTime,
    holdUntil: capRefusalHold(
      Math.max(batch.holdUntil ?? 0, retryAt.getTime()),
      currentTime,
    ),
    holdCount: batch.holdCount + 1,
  };
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

type PublisherRefusalState = {
  disposition: "backoff" | "terminal";
  count: number;
  progress: number;
  until: Date;
};
type RefusalOptions = {
  receipt: EuCompletionReceipt;
  retryAt: Date;
  now: () => number;
};
const preparePublisherRefusalTx = async (
  tx: Transaction,
  { receipt, retryAt, now }: RefusalOptions,
): Promise<PublisherRefusalState> => {
  const control = (
    await tx
      .select()
      .from(euCompletionControls)
      .where(eq(euCompletionControls.key, sourceControl(receipt.sourceId)))
      .for("update")
      .limit(1)
  ).at(0);
  const batch =
    control?.batch === undefined || control.batch === null
      ? initialBatchState()
      : decodeCheckpoint({ cursor: control.cursor, batch: control.batch })
          .batch;
  const progress = control?.healthyRows ?? 0;
  // Only publisher success after the latest refusal can isolate this document.
  const baseline = receipt.refusalProgress;
  const count = receipt.refusalCount + 1;
  const currentTime = now();
  const delay = Math.min(
    EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs,
    EU_COMPLETION_STORE_LIMITS.refusalMinHoldMs *
      2 ** Math.min(5, batch.holdCount),
  );
  return {
    disposition:
      receipt.refusalCount > 0 &&
      count >= EU_COMPLETION_STORE_LIMITS.maxDocumentRefusals &&
      progress > baseline
        ? "terminal"
        : "backoff",
    count,
    progress,
    until: new Date(
      Math.min(
        currentTime + EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs,
        Math.max(currentTime + delay, retryAt.getTime(), batch.holdUntil ?? 0),
      ),
    ),
  };
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
  settlement: { status, retryAt, detail, mirrorWait, refusal },
  decision,
  at,
}: ReceiptTransitionOptions) => {
  const released = status === "pending" || status === "fetched";
  const superseded = status === "superseded-by-crawl";
  const retrying =
    status === "failed-backoff" ||
    (status === "publisher-refused" && refusal?.disposition !== "terminal") ||
    superseded;
  const deferred = retrying || released;
  return {
    status,
    detail: detail?.slice(0, 512) ?? null,
    retryAt: deferred ? (retryAt ?? null) : null,
    mirrorWaits: receipt.mirrorWaits + Number(mirrorWait === "increment"),
    ...(refusal === undefined
      ? {}
      : {
          refusalCount: refusal.count,
          refusalProgress: refusal.progress,
          refusalHoldUntil: refusal.until,
        }),
    completionSourceHash: deferred ? null : (decision?.sourceHash ?? null),
    attempts:
      (status === "publisher-refused" || superseded || released) &&
      receipt.attemptState === "picked-up"
        ? Math.max(0, receipt.attempts - 1)
        : receipt.attempts,
    attemptState: "idle" as const,
    updatedAt: at,
    completedAt: deferred ? null : at,
    ...(deferred || mirrorWait === "increment" ? {} : { payload: null }),
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

const createWriteMarkerOperations = ({ now }: StoreContext) => {
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
  return { assertApprovalTx, assertFetchedTx, markWrittenTx };
};

type CompletionRetryTimeOptions = {
  retrying: boolean;
  retryAt: Date | undefined;
  now: () => number;
};
const assertCompletionRetryTime = ({
  retrying,
  retryAt,
  now,
}: CompletionRetryTimeOptions) => {
  if (
    (retrying && retryAt === undefined) ||
    (retryAt !== undefined &&
      (!Number.isFinite(retryAt.getTime()) || retryAt.getTime() <= now()))
  ) {
    panic("Completion backoff requires a future time");
  }
};

const createSettlementOperations = ({
  transaction,
  cleanup,
  now,
}: StoreContext) => {
  const finishTx = async (
    tx: Transaction,
    {
      id,
      status,
      retryAt: requestedRetryAt,
      detail,
      publisherSuccess = false,
      mirrorWait,
    }: SettleOptions,
  ) => {
    const receipt = await receiptTx(tx, id);
    if (!receiptIsActive(receipt)) {
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
    if (
      status === "publisher-refused" &&
      receipt.status === "publisher-refused" &&
      receipt.attemptState === "idle"
    ) {
      return receipt;
    }
    const refusal =
      status === "publisher-refused" && requestedRetryAt !== undefined
        ? await preparePublisherRefusalTx(tx, {
            receipt,
            retryAt: requestedRetryAt,
            now,
          })
        : undefined;
    const retryAt = refusal?.until ?? requestedRetryAt;
    const retrying =
      status === "failed-backoff" ||
      (status === "publisher-refused" && refusal?.disposition !== "terminal") ||
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
    assertCompletionRetryTime({ retrying, retryAt, now });
    const {
      status: settledStatus,
      attemptState,
      ...metadata
    } = receiptTransition({
      receipt,
      settlement: {
        id,
        status,
        ...(retryAt === undefined ? {} : { retryAt }),
        ...(detail === undefined ? {} : { detail }),
        ...(mirrorWait === undefined ? {} : { mirrorWait }),
        ...(refusal === undefined ? {} : { refusal }),
      },
      decision,
      at: new Date(now()),
    });
    const settled = await moveReceiptTx(tx, {
      receipt,
      status: settledStatus,
      attemptState,
      set: metadata,
    });
    if (status === "publisher-refused" && retryAt !== undefined) {
      await holdPublisherRefusalTx(tx, { receipt, retryAt, now });
    }
    if (settled.completedAt !== null) {
      await retireCompletedReceiptsTx(tx, {
        receipt: settled,
        status: settled.status,
      });
    }
    await recordCompletionProgressTx(tx, receipt, {
      status,
      now,
      publisherSuccess,
      ...(mirrorWait === undefined ? {} : { mirrorWait }),
    });
    return settled;
  };
  const finalize = async (id: string, publisherSuccess = false) =>
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
        await finishTx(tx, { id, status: disposition, publisherSuccess });
      }
      return disposition;
    });
  const waitForMirror = async (
    id: string,
  ): Promise<"waiting" | "review-required" | "applied"> =>
    await cleanup(async (tx) => {
      const receipt = await receiptTx(tx, id);
      if (receipt.status === "review-required") {
        return "review-required";
      }
      if (receipt.status === "applied") {
        return "applied";
      }
      if (
        receipt.attemptState === "idle" &&
        receipt.mirrorWaits > 0 &&
        receipt.retryAt !== null &&
        receipt.retryAt.getTime() > now()
      ) {
        return "waiting";
      }
      if (receipt.writtenAt === null) {
        panic("Mirror waiting requires its canonical write marker");
      }
      const verified = await verifyWrittenTx(tx, receipt);
      if (verified === "applied") {
        await finishTx(tx, { id, status: "applied" });
        return "applied";
      }
      const exhausted =
        verified === "review-required" ||
        receipt.mirrorWaits + 1 >= EU_COMPLETION_STORE_LIMITS.maxMirrorWaits;
      await finishTx(tx, {
        id,
        status: exhausted ? "review-required" : "fetched",
        detail: exhausted
          ? MIRROR_REPAIR_REQUIRED
          : "waiting for canonical mirror settlement",
        ...(exhausted
          ? {}
          : {
              retryAt: new Date(
                now() + EU_COMPLETION_STORE_LIMITS.mirrorWaitMs,
              ),
            }),
        mirrorWait: "increment",
      });
      return exhausted ? "review-required" : "waiting";
    });
  return {
    waitForMirror,
    finishTx,
    finalize,
  };
};

type CompletionPageOptions = {
  sourceId: EuCompletionReceipt["sourceId"];
  mode: EuCompletionMode;
  parserVersion: number;
  after: string | null;
  limit: number;
};
// Bound candidate work before examining durable receipts. A fully completed
// source advances one cheap page per tick instead of rescanning its corpus.
export const buildEuCompletionPageQuery = (
  tx: Transaction,
  { sourceId, mode, parserVersion, after, limit }: CompletionPageOptions,
) => {
  const candidates = tx
    .select({
      id: caseLawDecisions.id,
      sourceHash: caseLawDecisions.sourceHash,
      sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
      redactedAt: caseLawDecisions.redactedAt,
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        after === null
          ? undefined
          : gt(caseLawDecisions.id, sql`${after}::uuid`),
      ),
    )
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit)
    .as("completion_candidates");
  const matchingReceipt = and(
    eq(euCompletionReceipts.sourceId, sourceId),
    eq(euCompletionReceipts.decisionId, candidates.id),
    eq(euCompletionReceipts.mode, mode),
    eq(euCompletionReceipts.parserVersion, parserVersion),
  );
  return tx
    .select({
      id: candidates.id,
      sourceHash: candidates.sourceHash,
      sourceObservationOrder: candidates.sourceObservationOrder,
      eligible: sql<boolean>`${and(
        isNull(candidates.redactedAt),
        euCompletionDecisionNotWithdrawn(candidates.id),
        notExists(
          tx
            .select({ id: euCompletionReceipts.id })
            .from(euCompletionReceipts)
            .where(
              and(
                matchingReceipt,
                inArray(euCompletionReceipts.status, QUIESCENT),
                isNotNull(euCompletionReceipts.completedAt),
                sql`${euCompletionReceipts.completionSourceHash} IS NOT DISTINCT FROM ${candidates.sourceHash}`,
              ),
            ),
        ),
        notExists(
          tx
            .select({ id: euCompletionReceipts.id })
            .from(euCompletionReceipts)
            .where(
              and(
                matchingReceipt,
                inArray(euCompletionReceipts.status, [...ACTIVE, "failed"]),
                sql`(${euCompletionReceipts.status} <> 'publisher-refused' OR ${euCompletionReceipts.completedAt} IS NULL)`,
              ),
            ),
        ),
      )}`,
    })
    .from(candidates)
    .orderBy(asc(candidates.id))
    .limit(limit);
};

type ReadmitSettledMirrorOptions = Pick<
  EuCompletionReserveOptions,
  "sourceId" | "mode" | "parserVersion" | "limit"
> & {
  decisionIds: EuCompletionReceipt["decisionId"][];
  now: () => number;
};
const readmitSettledMirrorsTx = async (
  tx: Transaction,
  {
    sourceId,
    mode,
    parserVersion,
    limit,
    decisionIds,
    now,
  }: ReadmitSettledMirrorOptions,
) => {
  const repaired = await tx
    .select({
      receipt: euCompletionReceipts,
      sourceHash: caseLawDecisions.sourceHash,
      observationOrder: caseLawDecisions.sourceObservationOrder,
      documentParserVersion: caseLawDecisions.parserVersion,
    })
    .from(euCompletionReceipts)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, euCompletionReceipts.decisionId),
    )
    .where(
      and(
        eq(euCompletionReceipts.sourceId, sourceId),
        eq(euCompletionReceipts.mode, mode),
        eq(euCompletionReceipts.parserVersion, parserVersion),
        inArray(euCompletionReceipts.decisionId, decisionIds),
        eq(euCompletionReceipts.status, "review-required"),
        eq(euCompletionReceipts.detail, MIRROR_REPAIR_REQUIRED),
        isNotNull(euCompletionReceipts.writtenAt),
        isNull(euCompletionReceipts.supersededAt),
        isNull(caseLawDecisions.redactedAt),
        euCompletionDecisionNotWithdrawn(),
        eq(
          caseLawDecisions.corpusMirrorStatus,
          CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        ),
        eq(
          caseLawDecisions.sourceHash,
          euCompletionReceipts.completionSourceHash,
        ),
      ),
    )
    .orderBy(asc(euCompletionReceipts.id))
    .limit(limit)
    .for("update", { of: euCompletionReceipts });
  const markerCurrent = ({
    receipt,
    sourceHash,
    observationOrder,
    documentParserVersion,
  }: (typeof repaired)[number]) =>
    observationOrder === receipt.writtenObservationOrder &&
    documentParserVersion === receipt.writtenParserVersion &&
    sourceHash === receipt.writtenSourceHash;
  const current = repaired.filter(markerCurrent);
  const reclaimed = repaired.filter((row) => !markerCurrent(row));
  const readmission = {
    detail: null,
    completedAt: null,
    completionSourceHash: null,
    retryAt: null,
    updatedAt: new Date(now()),
  } as const;
  const readmit = async (
    rows: typeof repaired,
    { to, set }: { to: "fetched" | "pending"; set: ReceiptMetadata },
  ) => {
    const moved = await transitionLifecycleBatch({
      tx,
      spec: TRANSITIONS.euCompletionReceipts,
      ids: rows.map(({ receipt }) => receipt.id),
      moves: {
        status: { from: ["review-required"], to },
        attemptState: { from: ["idle", "picked-up", "repair"], to: "idle" },
      },
      set,
      recordTransitionAuditEvent: attributedToCompletionRun,
    });
    if (moved.length !== rows.length) {
      panic("Readmitted receipt was not updated");
    }
  };
  // A canonical repair may advance observation order without changing bytes.
  // Rows whose written marker still matches replay that write; the rest
  // reclassify against their current claim, each from the values read above.
  await readmit(current, { to: "fetched", set: readmission });
  await readmit(reclaimed, {
    to: "pending",
    set: {
      ...readmission,
      claimedFingerprint: null,
      payload: null,
      payloadHash: null,
      provenance: null,
      target: null,
      writtenAt: null,
      writtenSourceHash: null,
      writtenObservationOrder: null,
      writtenParserVersion: null,
      attempts: 0,
      mirrorWaits: 0,
    },
  });
  if (reclaimed.length > 0) {
    const claims = sql.join(
      reclaimed.map(
        ({ receipt, sourceHash, observationOrder }) =>
          sql`(${receipt.id}::text, ${sourceHash}::text, ${observationOrder}::bigint)`,
      ),
      sql`, `,
    );
    await tx
      .update(euCompletionReceipts)
      .set({
        claimedSourceHash: sql`claim.source_hash`,
        claimedObservationOrder: sql`claim.observation_order`,
      })
      .from(
        sql`(VALUES ${claims}) AS claim(id, source_hash, observation_order)`,
      )
      .where(eq(euCompletionReceipts.id, sql`claim.id`));
  }
  const rows =
    repaired.length === 0
      ? []
      : await tx
          .select()
          .from(euCompletionReceipts)
          .where(
            inArray(
              euCompletionReceipts.id,
              repaired.map(({ receipt }) => receipt.id),
            ),
          );
  // Keep the selection's order: callers process readmitted rows in it.
  const updated = new Map(rows.map((receipt) => [receipt.id, receipt]));
  const readmitted = repaired.map(
    ({ receipt }) =>
      updated.get(receipt.id) ?? panic("Readmitted receipt was not updated"),
  );
  return readmitted;
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
            sql`(${euCompletionReceipts.status} <> 'publisher-refused' OR ${euCompletionReceipts.completedAt} IS NULL)`,
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
      if (due.some((receipt) => receipt.status !== "publisher-refused")) {
        return due;
      }
      const pageQuery = (after: string | null) =>
        buildEuCompletionPageQuery(tx, {
          sourceId,
          mode,
          parserVersion,
          after,
          limit,
        });
      let page = await pageQuery(state.cursor);
      if (page.length === 0 && state.cursor !== null) {
        page = await pageQuery(null);
      }
      if (page.length === 0) {
        return due;
      }
      const readmitted = await readmitSettledMirrorsTx(tx, {
        sourceId,
        mode,
        parserVersion,
        limit,
        decisionIds: page.map((row) => row.id),
        now,
      });
      // Event identity remains stable across recovery; distinct target attempts
      // retain distinct identities even before their target can be classified.
      const eligible = page.filter((row) => row.eligible);
      const rows =
        eligible.length === 0
          ? []
          : await tx
              .insert(euCompletionReceipts)
              .values(
                eligible.map((row) => ({
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
      if (readmitted.length > 0) {
        return readmitted;
      }
      return rows.length === 0 ? due : rows;
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
        return await moveReceiptTx(tx, {
          receipt,
          status: "fetched",
          attemptState: receipt.attemptState,
          set: {
            payload,
            payloadHash,
            claimedFingerprint,
            target,
            provenance,
            updatedAt: new Date(now()),
          },
        });
      }),
    );
  };
  const pickup = async (id: string): Promise<"ready" | "waiting" | "failed"> =>
    await transaction(async (tx) => {
      const receipt = await receiptTx(tx, id);
      if (receipt.retryAt !== null && receipt.retryAt.getTime() > now()) {
        return "waiting";
      }
      if (!receiptIsActive(receipt) && receipt.status !== "failed") {
        return "waiting";
      }
      const document = (
        await tx
          .select({ notWithdrawn: euCompletionDecisionNotWithdrawn() })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, receipt.decisionId))
          .for("update")
          .limit(1)
      ).at(0);
      const withdrawn = document?.notWithdrawn === false;
      const attempts = receipt.status === "failed" ? 0 : receipt.attempts;
      const pickedState = receipt.writtenAt === null ? "picked-up" : "repair";
      const exhausted =
        attempts >= EU_COMPLETION_STORE_LIMITS.maxAttempts &&
        receipt.writtenAt === null;
      const resumedStatus = receipt.payload === null ? "pending" : "fetched";
      let nextStatus: EuCompletionReceipt["status"] = resumedStatus;
      let nextAttempts = attempts + Number(receipt.writtenAt === null);
      if (exhausted) {
        nextStatus = "failed";
        nextAttempts = attempts;
      }
      if (withdrawn) {
        nextStatus = "withdrawn";
        nextAttempts = Math.max(
          0,
          attempts - Number(receipt.attemptState === "picked-up"),
        );
      }
      const retryDuration = exhausted
        ? EU_COMPLETION_STORE_LIMITS.readmissionDays * DAY_IN_MS
        : retryDelay(attempts + 1);
      const nextRetryAt = withdrawn ? null : new Date(now() + retryDuration);
      await moveReceiptTx(tx, {
        receipt,
        status: nextStatus,
        attemptState: withdrawn || exhausted ? "idle" : pickedState,
        set: {
          attempts: nextAttempts,
          systemicFailures:
            receipt.status === "failed" ? 0 : receipt.systemicFailures,
          ...(withdrawn
            ? { payload: null, detail: "corpus document withdrawn" }
            : {}),
          retryAt: nextRetryAt,
          completedAt: withdrawn || exhausted ? new Date(now()) : null,
          updatedAt: new Date(now()),
        },
      });
      if (withdrawn) {
        return "waiting";
      }
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
      if (!receiptIsActive(current)) {
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
      await moveReceiptTx(tx, {
        receipt: current,
        status: exhausted ? "failed" : "failed-backoff",
        attemptState: "idle",
        set: {
          attempts: classification.attempts,
          systemicFailures: classification.systemicFailures,
          systemicProgress: classification.systemicProgress,
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
        },
      });
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
      await tx
        .delete(euCompletionRequestHours)
        .where(inArray(euCompletionRequestHours.hour, expiredHours));
      if (old.length === 0) {
        return 0;
      }
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
          if (receipt === undefined) {
            return Result.err(
              new CompletionApprovalError({
                code: "not-found",
                message: "The supervised receipt does not exist",
              }),
            );
          }
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
          ) {
            return Result.err(
              new CompletionApprovalError({
                code: "invalid-input",
                message:
                  "Approval requires attributed times, evidence and bounded reviewed counts",
              }),
            );
          }
          if (
            receipt.status !== "dry-run" ||
            receipt.mode !== "dry-run" ||
            receipt.completedAt === null ||
            receipt.sourceId !== approval.sourceId ||
            receipt.parserVersion !== approval.parserVersion ||
            approval.supervisedAt.getTime() < receipt.completedAt.getTime()
          ) {
            return Result.err(
              new CompletionApprovalError({
                code: "invalid-proof",
                message:
                  "Approval must reference a completed dry-run receipt for the same source and parser, supervised after completion",
              }),
            );
          }
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
          if (approved === undefined) {
            return Result.err(
              new CompletionApprovalError({
                code: "already-approved",
                message:
                  "This source and parser generation already has supervised approval",
              }),
            );
          }
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
    await transaction(async (tx) => {
      const key = sourceId === null ? GLOBAL_CONTROL : sourceControl(sourceId);
      await tx
        .insert(euCompletionControls)
        .values({ key, sourceId })
        .onConflictDoNothing();
      const moved = await transitionLifecycle({
        tx,
        spec: TRANSITIONS.euCompletionControls,
        id: key,
        moves: { state: { from: ["off", "on"], to: state } },
        set: { changedBy, changedAt },
        recordTransitionAuditEvent: attributedToCompletionRun,
      });
      if (moved.type === "stale") {
        panic("Completion control row disappeared under its transaction");
      }
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
      return row?.batch === undefined || row.batch === null
        ? initialBatchState()
        : decodeCheckpoint({ cursor: row.cursor, batch: row.batch }).batch;
    });
  const savePreflightGateState = async (batch: BatchState) =>
    await cleanup(async (tx) => {
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
    counts,
  }: {
    sourceId: EuCompletionReceipt["sourceId"];
    mode: EuCompletionMode;
    healthyCompleted: number;
    intentionallyHeld: boolean;
    counts: SystemAuditCounts<"system:eu-corpus-completion">;
  }) =>
    await cleanup(async (tx) => {
      // This module's writes are attributed to the completion actor's run:
      // one system audit row per tick that changed anything.
      await recordSystemAudit(tx, "system:eu-corpus-completion", {
        subject: createSafeId<"systemScriptRun">(),
        counts,
      });
      const madeProgress = healthyCompleted > 0;
      const shouldProgress = mode === "apply" && !intentionallyHeld;
      // Only verified settlement increments completedRows; caller metrics cannot
      // manufacture healthy evidence for systemic-failure isolation.
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
                sql`(${euCompletionReceipts.status} <> 'publisher-refused' OR ${euCompletionReceipts.completedAt} IS NULL)`,
              ),
            )
            .limit(1)
        ).length > 0;
      const mirrorRepairRequired =
        (
          await tx
            .select({ id: euCompletionReceipts.id })
            .from(euCompletionReceipts)
            .where(
              and(
                eq(euCompletionReceipts.sourceId, sourceId),
                eq(euCompletionReceipts.mode, mode),
                eq(euCompletionReceipts.parserVersion, parserVersion),
                eq(euCompletionReceipts.status, "review-required"),
                eq(euCompletionReceipts.detail, MIRROR_REPAIR_REQUIRED),
                isNull(euCompletionReceipts.supersededAt),
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
                sql`(${euCompletionReceipts.status} <> 'publisher-refused' OR ${euCompletionReceipts.completedAt} IS NULL)`,
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
        progress?.batch === undefined || progress.batch === null
          ? null
          : decodeCheckpoint({ cursor: progress.cursor, batch: progress.batch })
              .batch;
      const heldSince = sourceBatch?.heldSince ?? null;
      return {
        hasQueuedWork: queued,
        mirrorRepairRequired,
        sourceBackoffAgeMs:
          heldSince === null ? null : Math.max(0, now() - heldSince),
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
    ...createWriteMarkerOperations(context),
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
