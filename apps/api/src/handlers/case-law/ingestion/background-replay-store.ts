import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  initialBatchState,
  type BatchState,
  type Verdict,
} from "@stll/db-load-gate/health";
import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  caseLawReplaySourceProgress,
  caseLawReplayAuditEvents,
  databaseBackfillStates,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { recordReplayMaintenanceAuditEvent } from "@/api/lib/legal-search/case-law-replay-audit";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { logger } from "@/api/lib/observability/logger";

import { getAdapter } from "./adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplaySource,
  BackgroundReplayTickReport,
} from "./background-replay";
import {
  CASE_LAW_REPLAY_SCOPE,
  buildBackgroundReplayProbe,
  REPLAY_ROW_OUTCOME,
  replayCapability,
  selectReplayPage,
  selectScopeEnd,
  type ReplayRowReport,
} from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
  type ReplayEnrolment,
} from "./replay-enrolment";
import type { ReplayFailure } from "./replay-failure";

const withReplayTransaction = async <T>(
  db: CaseLawRootHandle,
  work: (tx: Transaction) => Promise<T>,
) =>
  await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, 5000);
    await setSharedLockTimeout(tx, 1000);
    return await work(tx);
  });

const checkpointName = (source: BackgroundReplaySource) =>
  `case-law-replay:${source.id}:${source.currentParserVersion}`;

const reservationBatch = (
  source: BackgroundReplaySource,
  row: typeof caseLawReplayBatches.$inferSelect,
): BackgroundReplayBatch => ({
  id: row.id,
  source,
  decisionId: row.firstDecisionId,
  parserVersionFrom: row.parserVersionFrom,
  targetParserVersion: row.parserVersionTo,
});

type ReplayStoreOptions = {
  db: CaseLawRootHandle;
  now: () => number;
  enrolment?: Readonly<Record<keyof typeof PARSER_VERSIONS, ReplayEnrolment>>;
  onLag?: (source: BackgroundReplaySource) => void;
  onBudgetExhausted?: (source: BackgroundReplaySource) => void;
  sourceEnabled?: (key: keyof typeof PARSER_VERSIONS) => boolean;
  beforeCheckpoint?: (tx: Transaction) => Promise<void>;
  beforeComplete?: () => Promise<void>;
  gate?: () => Promise<Verdict>;
  onHeld?: (source: BackgroundReplaySource, state: BatchState) => void;
};

type ReplayStoreContext = {
  db: CaseLawRootHandle;
  now: () => number;
  enrolment: Readonly<Record<keyof typeof PARSER_VERSIONS, ReplayEnrolment>>;
  onLag: ReplayStoreOptions["onLag"];
  onBudgetExhausted: ReplayStoreOptions["onBudgetExhausted"];
  beforeCheckpoint: ReplayStoreOptions["beforeCheckpoint"];
  sourceEnabled: ReplayStoreOptions["sourceEnabled"];
  beforeComplete: ReplayStoreOptions["beforeComplete"];
  gate: ReplayStoreOptions["gate"];
  onHeld: ReplayStoreOptions["onHeld"];
};

type DailyAllowanceOptions = {
  db: CaseLawRootHandle;
  source: BackgroundReplaySource;
  utcDay: string;
  currentTime: number;
};
const hasDailyAllowance = async ({
  db,
  source,
  utcDay,
  currentTime,
}: DailyAllowanceOptions) =>
  await withReplayTransaction(db, async (tx) => {
    const usage =
      (
        await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(caseLawReplayDailyRows)
          .where(
            and(
              eq(caseLawReplayDailyRows.sourceId, source.id),
              eq(caseLawReplayDailyRows.budgetDay, utcDay),
            ),
          )
      ).at(0)?.count ?? 0;
    if (usage < source.dailyBudget) {
      return true;
    }
    const recoverable = await tx
      .select({ id: caseLawReplayBatches.id })
      .from(caseLawReplayBatches)
      .innerJoin(
        caseLawReplayDailyRows,
        eq(caseLawReplayBatches.id, caseLawReplayDailyRows.batchId),
      )
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          eq(caseLawReplayBatches.status, "reserved"),
          or(
            isNull(caseLawReplayBatches.retryAt),
            lte(
              caseLawReplayBatches.retryAt,
              sql`${new Date(currentTime)}::timestamptz`,
            ),
          ),
          eq(caseLawReplayBatches.parserVersionTo, source.currentParserVersion),
          eq(caseLawReplayDailyRows.budgetDay, utcDay),
        ),
      )
      .limit(1);
    return recoverable.length > 0;
  });

const ROUND_ROBIN_CHECKPOINT = "case-law-replay:round-robin";
const previewCheckpointName = (source: BackgroundReplaySource) =>
  `${checkpointName(source)}:dry-run`;

const chooseSource = async (
  context: ReplayStoreContext,
): Promise<BackgroundReplaySource | null> => {
  const { db, now, enrolment, onLag, onBudgetExhausted, sourceEnabled, gate } =
    context;
  if (gate && (await gate()).kind !== "normal") {
    return null;
  }
  const previous = await withReplayTransaction(
    db,
    async (tx) =>
      (
        await tx
          .select({ cursor: databaseBackfillStates.cursor })
          .from(databaseBackfillStates)
          .where(eq(databaseBackfillStates.name, ROUND_ROBIN_CHECKPOINT))
          .limit(1)
      ).at(0)?.cursor ?? null,
  );
  const keys = Object.values(ADAPTER_KEYS);
  const previousKey = keys.find((key) => key === previous);
  const previousIndex =
    previousKey === undefined ? -1 : keys.indexOf(previousKey);
  const ordered = [
    ...keys.slice(previousIndex + 1),
    ...keys.slice(0, previousIndex + 1),
  ];
  for (const adapterKey of ordered) {
    const policy = enrolment[adapterKey];
    if (policy.mode === "off" || sourceEnabled?.(adapterKey) === false) {
      continue;
    }
    validateReplayEnrolment(policy);
    const adapter = getAdapter(adapterKey);
    if (!adapter || replayCapability(adapter).type === "unsupported") {
      panic("Enrolled adapter cannot replay stored raw");
    }
    // Each source is an independent failure boundary. Timeout or contention in
    // one source must not prevent the next source's bounded probe.
    const result = await Result.tryPromise(async () => {
      const source = (
        await withReplayTransaction(
          db,
          async (tx) =>
            await tx
              .select({ id: caseLawSources.id })
              .from(caseLawSources)
              .where(eq(caseLawSources.adapterKey, adapterKey))
              .limit(1),
        )
      ).at(0);
      if (!source) {
        return null;
      }
      const candidate: BackgroundReplaySource = {
        id: source.id,
        adapterKey,
        currentParserVersion: PARSER_VERSIONS[adapterKey],
        dailyBudget: policy.dailyBudget,
        mode: policy.mode,
        // A bounded existence probe supplies a lower bound, not a corpus census.
        rowsBehind: 1,
      };
      const state = await loadGateState(context, candidate);
      if (state.holdUntil !== null && state.holdUntil > now()) {
        context.onHeld?.(candidate, state);
        return null;
      }
      const pending = await withReplayTransaction(
        db,
        async (tx) =>
          (
            await tx
              .select({ id: caseLawReplayBatches.id })
              .from(caseLawReplayBatches)
              .where(
                and(
                  eq(caseLawReplayBatches.sourceId, source.id),
                  eq(caseLawReplayBatches.status, "reserved"),
                  or(
                    isNull(caseLawReplayBatches.retryAt),
                    lte(
                      caseLawReplayBatches.retryAt,
                      sql`${new Date(now())}::timestamptz`,
                    ),
                  ),
                ),
              )
              .limit(1)
          ).length > 0,
      );
      const probe = pending
        ? true
        : await withReplayTransaction(
            db,
            async (tx) =>
              (
                await buildBackgroundReplayProbe(tx, {
                  sourceId: candidate.id,
                  currentParserVersion: candidate.currentParserVersion,
                })
              ).length > 0,
          );
      if (!probe) {
        return null;
      }
      onLag?.(candidate);
      if (
        candidate.mode === "enrolled" &&
        !(await hasDailyAllowance({
          db,
          source: candidate,
          utcDay: new Date(now()).toISOString().slice(0, 10),
          currentTime: now(),
        }))
      ) {
        onBudgetExhausted?.(candidate);
        return null;
      }
      return candidate;
    });
    if (result.isErr()) {
      logger.warn("case_law_replay.source_probe_failed", { adapterKey });
      continue;
    }
    const selected = result.value;
    if (selected === null) {
      continue;
    }
    // persists fairness across independent scheduled ticks
    await withReplayTransaction(db, async (tx) => {
      await tx
        .insert(databaseBackfillStates)
        .values({
          name: ROUND_ROBIN_CHECKPOINT,
          cursor: adapterKey,
          batch: initialBatchState(),
        })
        .onConflictDoUpdate({
          target: databaseBackfillStates.name,
          set: { cursor: adapterKey, updatedAt: new Date(now()) },
        });
      // durable source scheduling observation without document identifiers
      await tx
        .insert(caseLawReplaySourceProgress)
        .values({ sourceId: selected.id, lastServedAt: new Date(now()) })
        .onConflictDoUpdate({
          target: caseLawReplaySourceProgress.sourceId,
          set: { lastServedAt: new Date(now()) },
        });
      await recordReplayMaintenanceAuditEvent(tx, {
        sourceId: selected.id,
        action: "source-scheduled",
        resourceId: selected.id,
        details: {},
        createdAt: new Date(now()),
      });
    });
    return selected;
  }
  return null;
};
type SelectNextOptions = {
  source: BackgroundReplaySource;
  after: BackgroundReplayBatch["decisionId"] | null;
};

const selectNext = async (
  tx: Transaction,
  { source, after }: SelectNextOptions,
) => {
  const scopedDb = async <T>(work: (tx: Transaction) => Promise<T>) =>
    await work(tx);
  const selection = {
    type: "background",
    currentParserVersion: source.currentParserVersion,
  } as const;
  const until = await selectScopeEnd({
    scopedDb,
    sourceId: source.id,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    selection,
  });
  if (until === null) {
    return null;
  }
  return (
    (
      await selectReplayPage({
        scopedDb,
        sourceId: source.id,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
        selection,
        after,
        until,
        limit: 1,
      })
    ).at(0) ?? null
  );
};
type PreviewBatchOptions = {
  source: BackgroundReplaySource;
  after: BackgroundReplayBatch["decisionId"] | null;
};

const previewBatch = async (
  { db }: ReplayStoreContext,
  { source, after }: PreviewBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    const persisted =
      after === null
        ? ((
            await tx
              .select({ cursor: databaseBackfillStates.cursor })
              .from(databaseBackfillStates)
              .where(
                eq(databaseBackfillStates.name, previewCheckpointName(source)),
              )
              .limit(1)
          ).at(0)?.cursor ?? null)
        : after;
    const cursorRow =
      persisted === null
        ? null
        : ((
            await tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, sql`${persisted}::uuid`))
              .limit(1)
          ).at(0)?.id ?? null);
    let row = await selectNext(tx, { source, after: cursorRow });
    if (!row && after === null && cursorRow !== null) {
      row = await selectNext(tx, { source, after: null });
    }
    return row === null
      ? null
      : {
          id: `${source.id}:${source.currentParserVersion}:${row.id}`,
          source,
          decisionId: row.id,
          parserVersionFrom: row.parserVersion,
          targetParserVersion: source.currentParserVersion,
        };
  });
type AdmitDailyRowOptions = {
  source: BackgroundReplaySource;
  batchId: string;
  utcDay: string;
};

const admitDailyRow = async (
  tx: Transaction,
  { source, batchId, utcDay }: AdmitDailyRowOptions,
) => {
  const charged =
    (
      await tx
        .select({ id: caseLawReplayDailyRows.batchId })
        .from(caseLawReplayDailyRows)
        .where(
          and(
            eq(caseLawReplayDailyRows.batchId, batchId),
            eq(caseLawReplayDailyRows.budgetDay, utcDay),
          ),
        )
        .limit(1)
    ).length > 0;
  if (charged) {
    return true;
  }
  const usage =
    (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(caseLawReplayDailyRows)
        .where(
          and(
            eq(caseLawReplayDailyRows.sourceId, source.id),
            eq(caseLawReplayDailyRows.budgetDay, utcDay),
          ),
        )
    ).at(0)?.count ?? 0;
  if (usage >= source.dailyBudget) {
    return false;
  }
  // accounts for one maintenance row per UTC day, including recovery
  await tx
    .insert(caseLawReplayDailyRows)
    .values({ batchId, sourceId: source.id, budgetDay: utcDay })
    .onConflictDoNothing();
  await recordReplayMaintenanceAuditEvent(tx, {
    sourceId: source.id,
    action: "daily-row-charged",
    resourceId: batchId,
    details: {},
  });
  return true;
};
type PendingInTransactionOptions = {
  source: BackgroundReplaySource;
  utcDay: string;
  now: number;
};

const pendingInTransaction = async (
  tx: Transaction,
  { source, utcDay, now }: PendingInTransactionOptions,
) => {
  const row = (
    await tx
      .select()
      .from(caseLawReplayBatches)
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          eq(caseLawReplayBatches.status, "reserved"),
          or(
            isNull(caseLawReplayBatches.retryAt),
            lte(
              caseLawReplayBatches.retryAt,
              sql`${new Date(now)}::timestamptz`,
            ),
          ),
        ),
      )
      .orderBy(
        asc(caseLawReplayBatches.createdAt),
        asc(caseLawReplayBatches.id),
      )
      .limit(1)
  ).at(0);
  if (!row) {
    return { type: "empty" } as const;
  }
  if (row.parserVersionTo > source.currentParserVersion) {
    panic("Pending replay targets a newer parser; this worker must stop");
  }
  if (row.parserVersionTo < source.currentParserVersion) {
    // preserves the superseded reservation before current-parser work
    await tx
      .update(caseLawReplayBatches)
      .set({ status: "superseded", completedAt: sql`now()` })
      .where(eq(caseLawReplayBatches.id, row.id));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "receipt-superseded",
      resourceId: row.id,
      details: { parserVersion: row.parserVersionTo },
      createdAt: new Date(now),
    });
    return { type: "empty" } as const;
  }
  if (!(await admitDailyRow(tx, { source, batchId: row.id, utcDay }))) {
    return { type: "budget-exhausted" } as const;
  }
  return { type: "reserved", batch: reservationBatch(source, row) } as const;
};
const lockCheckpoint = async (
  tx: Transaction,
  source: BackgroundReplaySource,
) => {
  const name = checkpointName(source);
  // initializes owner-only maintenance checkpoint
  const initialized = await tx
    .insert(databaseBackfillStates)
    .values({ name, batch: { ...initialBatchState(), size: 1 } })
    .onConflictDoNothing()
    .returning({ name: databaseBackfillStates.name });
  if (initialized.length > 0) {
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "checkpoint-created",
      resourceId: name,
      details: {},
    });
  }
  const state = (
    await tx
      .select()
      .from(databaseBackfillStates)
      .where(eq(databaseBackfillStates.name, name))
      .for("update")
      .limit(1)
  ).at(0);
  return state ?? panic("Replay checkpoint was not created");
};
type PendingBatchOptions = {
  source: BackgroundReplaySource;
  utcDay: string;
};

const pendingBatch = async (
  { db, now }: ReplayStoreContext,
  { source, utcDay }: PendingBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, source);
    return await pendingInTransaction(tx, { source, utcDay, now: now() });
  });
const loadGateState = async (
  { db }: ReplayStoreContext,
  source: BackgroundReplaySource,
): Promise<BatchState> =>
  await withReplayTransaction(db, async (tx) => {
    const row = (
      await tx
        .select()
        .from(databaseBackfillStates)
        .where(eq(databaseBackfillStates.name, checkpointName(source)))
        .limit(1)
    ).at(0);
    return row?.batch ?? { ...initialBatchState(), size: 1 };
  });
type SaveGateStateOptions = {
  source: BackgroundReplaySource;
  batch: BatchState;
};

const saveGateState = async (
  { db, now }: ReplayStoreContext,
  { source, batch }: SaveGateStateOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    // maintenance pacing state has no tenant or document mutation
    await tx
      .insert(databaseBackfillStates)
      .values({ name: checkpointName(source), batch })
      .onConflictDoUpdate({
        target: databaseBackfillStates.name,
        set: { batch, updatedAt: new Date(now()) },
      });
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "gate-state-saved",
      resourceId: checkpointName(source),
      details: {},
      createdAt: new Date(now()),
    });
  });
type ReserveBatchOptions = PendingBatchOptions & { verdict: Verdict };

const reserveBatch = async (
  { db, now }: ReplayStoreContext,
  { source, utcDay, verdict }: ReserveBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    const state = await lockCheckpoint(tx, source);
    const pending = await pendingInTransaction(tx, {
      source,
      utcDay,
      now: now(),
    });
    if (pending.type !== "empty") {
      return pending;
    }
    const usage =
      (
        await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(caseLawReplayDailyRows)
          .where(
            and(
              eq(caseLawReplayDailyRows.sourceId, source.id),
              eq(caseLawReplayDailyRows.budgetDay, utcDay),
            ),
          )
      ).at(0)?.count ?? 0;
    if (usage >= source.dailyBudget) {
      return { type: "budget-exhausted" } as const;
    }
    const after = state.cursor;
    // Cursor strings originate from branded database IDs, never external input.
    const cursorRow =
      after === null
        ? null
        : (
            await tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, sql`${after}::uuid`))
              .limit(1)
          ).at(0);
    let row = await selectNext(tx, { source, after: cursorRow?.id ?? null });
    if (!row && after !== null) {
      row = await selectNext(tx, { source, after: null });
    }
    if (!row) {
      return { type: "empty" } as const;
    }
    const id = `${source.id}:${source.currentParserVersion}:${row.id}`;
    // deterministic maintenance reservation and daily budget charge
    const reserved = (
      await tx
        .insert(caseLawReplayBatches)
        .values({
          id,
          sourceId: source.id,
          firstDecisionId: row.id,
          lastDecisionId: row.id,
          parserVersionFrom: row.parserVersion,
          parserVersionTo: source.currentParserVersion,
          budgetDay: utcDay,
          status: "reserved",
          attempted: 1,
          gateVerdict: verdict,
        })
        .onConflictDoNothing()
        .returning()
    ).at(0);
    if (!reserved) {
      logger.warn("case_law_replay.reservation_contended", {
        adapterKey: source.adapterKey,
      });
      return { type: "empty" } as const;
    }
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "receipt-reserved",
      resourceId: id,
      details: { parserVersion: source.currentParserVersion },
      createdAt: new Date(now()),
    });
    if (!(await admitDailyRow(tx, { source, batchId: id, utcDay }))) {
      return panic("Replay budget changed under checkpoint lock");
    }
    return {
      type: "reserved",
      batch: reservationBatch(source, reserved),
    } as const;
  });
type CompleteBatchOptions = {
  batch: BackgroundReplayBatch;
  report: ReplayRowReport;
  durationMs: number;
  verdict: Verdict;
};

type VerifiedProgressOptions = {
  sourceId: BackgroundReplaySource["id"];
  completedAt: Date;
};
const recordVerifiedProgress = async (
  tx: Transaction,
  { sourceId, completedAt }: VerifiedProgressOptions,
) => {
  // source progress and the verified receipt commit atomically
  await tx
    .insert(caseLawReplaySourceProgress)
    .values({ sourceId, ticksWithoutProgress: 0, lastCompletedAt: completedAt })
    .onConflictDoUpdate({
      target: caseLawReplaySourceProgress.sourceId,
      set: { ticksWithoutProgress: 0, lastCompletedAt: completedAt },
    });
  await recordReplayMaintenanceAuditEvent(tx, {
    sourceId,
    action: "progress-completed",
    resourceId: sourceId,
    details: { ticksWithoutProgress: 0 },
    createdAt: completedAt,
  });
};

type ReplayFailureOptions = {
  code: ReplayFailure["code"];
  messageClass: ReplayFailure["messageClass"];
  haltReason?: string;
  durationMs: number;
  verdict: Verdict;
};

const recordFailure = async (
  { db, now, beforeComplete }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
  failure: ReplayFailureOptions,
): Promise<"retryable" | "failed" | "applied"> => {
  await beforeComplete?.();
  return await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    const receipt =
      (
        await tx
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, batch.id))
          .for("update")
          .limit(1)
      ).at(0) ?? panic("Replay failure has no reservation");
    if (receipt.status !== "reserved") {
      return receipt.applied > 0 ? "applied" : "failed";
    }
    const attempts = receipt.attempts + 1;
    const decision = (
      await tx
        .select({
          parserVersion: caseLawDecisions.parserVersion,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, batch.decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (
      decision !== undefined &&
      decision.redactedAt === null &&
      (decision.parserVersion ?? -1) >= batch.targetParserVersion
    ) {
      // A failed receipt write can follow a successful canonical decision write.
      // The database stamp wins over retry exhaustion, including the last attempt.
      // verifies the applied maintenance receipt after a post-write failure
      await tx
        .update(caseLawReplayBatches)
        .set({
          status: "completed",
          outcome: REPLAY_ROW_OUTCOME.APPLIED,
          attempts,
          applied: 1,
          blocked: 0,
          failed: 0,
          retryAt: null,
          failureCode: failure.code,
          failureMessageClass: failure.messageClass,
          durationMs: Math.ceil(failure.durationMs),
          gateVerdict: failure.verdict,
          completedAt: new Date(now()),
        })
        .where(eq(caseLawReplayBatches.id, batch.id));
      await recordVerifiedProgress(tx, {
        sourceId: batch.source.id,
        completedAt: new Date(now()),
      });
      // a verified completion precedes cursor advancement atomically
      await tx
        .update(databaseBackfillStates)
        .set({ cursor: batch.decisionId, updatedAt: new Date(now()) })
        .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
      await recordReplayMaintenanceAuditEvent(tx, {
        sourceId: batch.source.id,
        action: "receipt-applied",
        resourceId: batch.id,
        details: { attempts, status: "completed", failureCode: failure.code },
        createdAt: new Date(now()),
      });
      return "applied";
    }
    const exhausted = attempts >= BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
    const retryDelay = Math.min(
      BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
      BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs * 2 ** (attempts - 1),
    );
    // persists bounded owner-only retry state before advancing the sweep
    await tx
      .update(caseLawReplayBatches)
      .set({
        attempts,
        failed: 1,
        status: exhausted ? "failed" : "reserved",
        retryAt: exhausted ? null : new Date(now() + retryDelay),
        failureCode: failure.code,
        failureMessageClass: failure.messageClass,
        outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
        durationMs: Math.ceil(failure.durationMs),
        gateVerdict: failure.verdict,
        completedAt: exhausted ? new Date(now()) : null,
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    if (exhausted) {
      // poison rows are excluded only for the failed parser version
      await tx
        .insert(caseLawReplayBlocked)
        .values({
          sourceId: batch.source.id,
          decisionId: batch.decisionId,
          parserVersionFrom: batch.parserVersionFrom,
          parserVersionTo: batch.targetParserVersion,
          reason: "retry-exhausted",
          detail: failure.code,
        })
        .onConflictDoNothing();
    }
    // failed row is durably queued or excluded before later work
    await tx
      .update(databaseBackfillStates)
      .set({ cursor: batch.decisionId, updatedAt: new Date(now()) })
      .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: batch.source.id,
      action: "receipt-failed",
      resourceId: batch.id,
      details: {
        attempts,
        status: exhausted ? "failed" : "reserved",
        failureCode: failure.code,
      },
      createdAt: new Date(now()),
    });
    return exhausted ? "failed" : "retryable";
  });
};

type CompletionBlockedReasonOptions = {
  moved: boolean;
  report: ReplayRowReport;
  decision:
    | Pick<typeof caseLawDecisions.$inferSelect, "parserVersion" | "redactedAt">
    | undefined;
};
const completionBlockedReason = ({
  moved,
  report,
  decision,
}: CompletionBlockedReasonOptions):
  | (typeof caseLawReplayBlocked.$inferInsert)["reason"]
  | null => {
  if (moved) {
    return null;
  }
  if (report.outcome === REPLAY_ROW_OUTCOME.MISSING_PAYLOAD) {
    return "missing-payload";
  }
  if (report.outcome === REPLAY_ROW_OUTCOME.REJECTED) {
    return (
      report.rejection ?? panic("Replay rejection has no classified reason")
    );
  }
  if (decision === undefined) {
    return "superseded";
  }
  if (decision.redactedAt !== null) {
    return "redacted";
  }
  return "no-write-settled";
};

const completeBatch = async (
  context: ReplayStoreContext,
  { batch, report, durationMs, verdict }: CompleteBatchOptions,
): Promise<"applied" | "blocked" | "unchanged" | "retryable"> => {
  const { db, now, beforeCheckpoint, beforeComplete } = context;
  if (report.id !== batch.decisionId) {
    panic("Replay report does not match its reservation");
  }
  if (report.outcome === REPLAY_ROW_OUTCOME.RETRYABLE) {
    const failure = await recordFailure(context, batch, {
      code: "writer-retryable",
      messageClass: "write",
      durationMs,
      verdict,
    });
    return failure === "failed" ? "blocked" : failure;
  }
  if (
    report.outcome !== REPLAY_ROW_OUTCOME.APPLIED &&
    report.outcome !== REPLAY_ROW_OUTCOME.UNCHANGED &&
    report.outcome !== REPLAY_ROW_OUTCOME.REJECTED &&
    report.outcome !== REPLAY_ROW_OUTCOME.MISSING_PAYLOAD
  ) {
    panic("Background replay cannot complete a non-terminal apply outcome");
  }
  await beforeComplete?.();
  return await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    const receipt =
      (
        await tx
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, batch.id))
          .for("update")
          .limit(1)
      ).at(0) ?? panic("Replay completion has no reservation");
    if (receipt.status !== "reserved") {
      return receipt.applied > 0 ? "applied" : "blocked";
    }
    const decision = (
      await tx
        .select({
          parserVersion: caseLawDecisions.parserVersion,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, batch.decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    const moved =
      decision !== undefined &&
      decision.redactedAt === null &&
      (decision.parserVersion ?? -1) >= batch.targetParserVersion;
    const reason = completionBlockedReason({ moved, report, decision });
    if (reason !== null) {
      // reported completion without a database stamp is a terminal exclusion
      await tx
        .insert(caseLawReplayBlocked)
        .values({
          sourceId: batch.source.id,
          decisionId: batch.decisionId,
          parserVersionFrom: batch.parserVersionFrom,
          parserVersionTo: batch.targetParserVersion,
          reason,
          detail: reason,
        })
        .onConflictDoNothing();
    }
    // A recovered write is applied even when the replay reports unchanged.
    // The parser stamp, read under the same fence, is the completion authority.
    // settles the owner-only receipt from verified database state
    await tx
      .update(caseLawReplayBatches)
      .set({
        status: moved ? "completed" : "superseded",
        outcome: moved
          ? REPLAY_ROW_OUTCOME.APPLIED
          : REPLAY_ROW_OUTCOME.REJECTED,
        applied: Number(moved),
        blocked: Number(!moved),
        failed: 0,
        attempts: receipt.attempts + 1,
        retryAt: null,
        durationMs: Math.ceil(durationMs),
        gateVerdict: verdict,
        completedAt: new Date(now()),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    if (moved) {
      await recordVerifiedProgress(tx, {
        sourceId: batch.source.id,
        completedAt: new Date(now()),
      });
    }
    await beforeCheckpoint?.(tx);
    // advances only after a verified terminal receipt or exclusion
    await tx
      .update(databaseBackfillStates)
      .set({ cursor: batch.decisionId, updatedAt: new Date(now()) })
      .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: batch.source.id,
      action: moved ? "receipt-applied" : "receipt-blocked",
      resourceId: batch.id,
      details: {
        attempts: receipt.attempts + 1,
        status: moved ? "completed" : "superseded",
      },
      createdAt: new Date(now()),
    });
    return moved ? "applied" : "blocked";
  });
};

const advancePreview = async (
  { db, now }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
) =>
  await withReplayTransaction(db, async (tx) => {
    // dry-run cursor is separate from apply and never mutates decisions
    await tx
      .insert(databaseBackfillStates)
      .values({
        name: previewCheckpointName(batch.source),
        cursor: batch.decisionId,
        batch: initialBatchState(),
      })
      .onConflictDoUpdate({
        target: databaseBackfillStates.name,
        set: { cursor: batch.decisionId, updatedAt: new Date(now()) },
      });
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: batch.source.id,
      action: "dry-run-advanced",
      resourceId: previewCheckpointName(batch.source),
      details: {},
      createdAt: new Date(now()),
    });
  });

const resetDryRunCursor = async (
  { db, now }: ReplayStoreContext,
  source: BackgroundReplaySource,
) =>
  await withReplayTransaction(db, async (tx) => {
    // explicit reset of owner-only dry-run progress
    await tx
      .update(databaseBackfillStates)
      .set({ cursor: null, updatedAt: new Date(now()) })
      .where(eq(databaseBackfillStates.name, previewCheckpointName(source)));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "dry-run-reset",
      resourceId: previewCheckpointName(source),
      details: {},
      createdAt: new Date(now()),
    });
  });

const compact = async ({ db, now }: ReplayStoreContext, limit: number) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > BACKGROUND_REPLAY_LIMITS.maxCompactRows
  ) {
    panic("Replay compaction limit must be a bounded positive integer");
  }
  return await withReplayTransaction(db, async (tx) => {
    const old = await tx
      .select({
        id: caseLawReplayBatches.id,
        sourceId: caseLawReplayBatches.sourceId,
        decisionId: caseLawReplayBatches.firstDecisionId,
        parserVersionTo: caseLawReplayBatches.parserVersionTo,
      })
      .from(caseLawReplayBatches)
      .where(
        and(
          inArray(caseLawReplayBatches.status, [
            "completed",
            "superseded",
            "failed",
          ]),
          lte(
            caseLawReplayBatches.completedAt,
            sql`${new Date(now() - BACKGROUND_REPLAY_LIMITS.receiptRetentionDays * DAY_IN_MS)}::timestamptz`,
          ),
          sql`EXISTS (SELECT 1 FROM case_law_replay_batches newer WHERE newer.source_id = ${caseLawReplayBatches.sourceId} AND newer.first_decision_id = ${caseLawReplayBatches.firstDecisionId} AND newer.parser_version_to > ${caseLawReplayBatches.parserVersionTo})`,
        ),
      )
      .orderBy(
        asc(caseLawReplayBatches.completedAt),
        asc(caseLawReplayBatches.id),
      )
      .limit(limit)
      .for("update");
    const auditPage = await tx
      .select({ id: caseLawReplayAuditEvents.id })
      .from(caseLawReplayAuditEvents)
      .where(
        lte(
          caseLawReplayAuditEvents.createdAt,
          sql`${new Date(now() - BACKGROUND_REPLAY_LIMITS.receiptRetentionDays * DAY_IN_MS)}::timestamptz`,
        ),
      )
      .orderBy(
        asc(caseLawReplayAuditEvents.createdAt),
        asc(caseLawReplayAuditEvents.id),
      )
      .limit(limit)
      .for("update");
    if (old.length === 0 && auditPage.length === 0) {
      return 0;
    }
    if (auditPage.length > 0) {
      await tx.delete(caseLawReplayAuditEvents).where(
        inArray(
          caseLawReplayAuditEvents.id,
          auditPage.map(({ id }) => id),
        ),
      );
    }
    if (old.length === 0) {
      await recordReplayMaintenanceAuditEvent(tx, {
        action: "receipts-compacted",
        resourceId: "case-law-replay:retention",
        details: {
          compactedReceipts: 0,
          compactedAuditEvents: auditPage.length,
        },
        createdAt: new Date(now()),
      });
      return 0;
    }
    const ids = old.map(({ id }) => id);
    // daily charges precede parent deletion because their FK restricts deletion
    await tx
      .delete(caseLawReplayDailyRows)
      .where(inArray(caseLawReplayDailyRows.batchId, ids));
    // tuple membership is bounded by the locked compaction page
    await tx.delete(caseLawReplayBlocked).where(
      sql`(${caseLawReplayBlocked.sourceId}, ${caseLawReplayBlocked.decisionId}, ${caseLawReplayBlocked.parserVersionTo}) IN (${sql.join(
        old.map(
          (row) =>
            sql`(${row.sourceId}::uuid, ${row.decisionId}::uuid, ${row.parserVersionTo}::int)`,
        ),
        sql`, `,
      )})`,
    );
    // bounded superseded receipt retention, latest receipt preserved
    const compacted = (
      await tx
        .delete(caseLawReplayBatches)
        .where(inArray(caseLawReplayBatches.id, ids))
        .returning({ id: caseLawReplayBatches.id })
    ).length;
    await recordReplayMaintenanceAuditEvent(tx, {
      action: "receipts-compacted",
      resourceId: "case-law-replay:retention",
      details: {
        compactedReceipts: compacted,
        compactedAuditEvents: auditPage.length,
        receiptIds: ids,
      },
      createdAt: new Date(now()),
    });
    return compacted;
  });
};

const recordTick = async (
  { db, now }: ReplayStoreContext,
  report: BackgroundReplayTickReport,
) => {
  if (report.source === null || report.source.mode === "dry-run") {
    return null;
  }
  const sourceId = report.source.id;
  const madeProgress = report.applied > 0;
  const intentionallyHeld =
    report.attempted === 0 &&
    [
      "held",
      "killed",
      "budget-exhausted",
      "lease-unavailable",
      "slot-unavailable",
      "empty",
    ].some((status) => status === report.status);
  const increment = intentionallyHeld ? 0 : 1;
  return await withReplayTransaction(db, async (tx) => {
    // owner-only progress signal resets only for verified completed rows
    const row = (
      await tx
        .insert(caseLawReplaySourceProgress)
        .values({
          sourceId,
          ticksWithoutProgress: madeProgress || intentionallyHeld ? 0 : 1,
          lastCompletedAt: madeProgress ? new Date(now()) : null,
        })
        .onConflictDoUpdate({
          target: caseLawReplaySourceProgress.sourceId,
          set: {
            ticksWithoutProgress: madeProgress
              ? 0
              : sql`${caseLawReplaySourceProgress.ticksWithoutProgress} + ${increment}`,
            lastCompletedAt: madeProgress
              ? new Date(now())
              : sql`${caseLawReplaySourceProgress.lastCompletedAt}`,
          },
        })
        .returning({
          ticksWithoutProgress:
            caseLawReplaySourceProgress.ticksWithoutProgress,
          lastCompletedAt: caseLawReplaySourceProgress.lastCompletedAt,
        })
    ).at(0);
    if (!row) {
      panic("Replay source progress upsert returned no row");
    }
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId,
      action: "tick-recorded",
      resourceId: sourceId,
      details: { ticksWithoutProgress: row.ticksWithoutProgress },
      createdAt: new Date(now()),
    });
    return row;
  });
};

/** Owner-only state for a public-corpus maintenance task; no tenant data. */
export const createBackgroundReplayStore = ({
  db,
  now,
  enrolment = REPLAY_ENROLMENT,
  onLag,
  beforeCheckpoint,
  sourceEnabled,
  onBudgetExhausted,
  beforeComplete,
  gate,
  onHeld,
}: ReplayStoreOptions) => {
  const context = {
    db,
    now,
    enrolment,
    onLag,
    beforeCheckpoint,
    sourceEnabled,
    onBudgetExhausted,
    beforeComplete,
    gate,
    onHeld,
  };
  return {
    chooseSource: async () => await chooseSource(context),
    recordTick: async (report: BackgroundReplayTickReport) =>
      await recordTick(context, report),
    recordFailure: async (
      batch: BackgroundReplayBatch,
      failure: ReplayFailureOptions,
    ) => await recordFailure(context, batch, failure),
    advancePreview: async (batch: BackgroundReplayBatch) =>
      await advancePreview(context, batch),
    resetDryRunCursor: async (source: BackgroundReplaySource) =>
      await resetDryRunCursor(context, source),
    compact: async (limit = BACKGROUND_REPLAY_LIMITS.maxCompactRows) =>
      await compact(context, limit),
    previewBatch: async (
      source: BackgroundReplaySource,
      after: BackgroundReplayBatch["decisionId"] | null,
    ) => await previewBatch(context, { source, after }),
    pendingBatch: async (source: BackgroundReplaySource, utcDay: string) =>
      await pendingBatch(context, { source, utcDay }),
    loadGateState: async (source: BackgroundReplaySource) =>
      await loadGateState(context, source),
    saveGateState: async (source: BackgroundReplaySource, batch: BatchState) =>
      await saveGateState(context, { source, batch }),
    reserveBatch: async (
      source: BackgroundReplaySource,
      utcDay: string,
      verdict: Verdict,
    ) => await reserveBatch(context, { source, utcDay, verdict }),
    completeBatch: async (
      batch: BackgroundReplayBatch,
      options: Omit<CompleteBatchOptions, "batch">,
    ) => await completeBatch(context, { batch, ...options }),
  };
};
