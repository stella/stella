import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import {
  initialBatchState,
  type BatchState,
  type Verdict,
} from "@stll/db-load-gate/health";
import { DAY_IN_MS } from "@stll/time";

import { decodeCheckpoint } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  caseLawReplaySourceProgress,
  caseLawReplayAuditEvents,
  type ReplayMaintenanceAuditDetails,
  databaseBackfillStates,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { escapeLike } from "@/api/lib/escape-like";
import { recordReplayMaintenanceAuditEvent } from "@/api/lib/legal-search/case-law-replay-audit";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { logger } from "@/api/lib/observability/logger";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import { getAdapter } from "./adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplaySource,
  BackgroundReplayReservation,
  BackgroundReplayTickReport,
} from "./background-replay";
import {
  CASE_LAW_REPLAY_SCOPE,
  BACKGROUND_REPLAY_PREVIEW_SUFFIX,
  buildBackgroundReplayProbe,
  REPLAY_ROW_OUTCOME,
  replayCapability,
  replayRowResult,
  selectReplayPage,
  selectScopeEnd,
  type ReplayRowReport,
  type ReplayRowResult,
} from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
  type ReplayEnrolment,
} from "./replay-enrolment";
import {
  REPLAY_PREVIEW_FAILURE,
  replayFailure,
  type ReplayFailure,
} from "./replay-failure";

const withReplayTransaction = async <T>(
  db: CaseLawRootHandle,
  work: (tx: Transaction) => Promise<T>,
) =>
  await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, 5000);
    await setSharedLockTimeout(tx, 1000);
    return await work(tx);
  });

const REPLAY_SYSTEMIC_ISOLATION_THRESHOLD = 3;
const PREFLIGHT_CHECKPOINT = "case-law-replay:preflight";

const checkpointName = (
  source: Pick<BackgroundReplaySource, "id" | "currentParserVersion">,
) => `case-law-replay:${source.id}:${source.currentParserVersion}`;

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
          source.mode === "dry-run"
            ? and(
                eq(caseLawReplayBatches.status, "completed"),
                eq(caseLawReplayBatches.failed, 1),
                or(
                  isNull(caseLawReplayBatches.outcome),
                  ne(
                    caseLawReplayBatches.outcome,
                    REPLAY_PREVIEW_FAILURE.RETRY_EXHAUSTED,
                  ),
                ),
                sql`${caseLawReplayBatches.id} LIKE ${`${escapeLike(`${source.id}:${source.currentParserVersion}:`)}%${escapeLike(BACKGROUND_REPLAY_PREVIEW_SUFFIX)}`}`,
              )
            : inArray(caseLawReplayBatches.status, [
                "reserved",
                "retry-exhausted",
              ]),
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
  const availableSources = await withReplayTransaction(
    db,
    async (tx) =>
      await tx
        .select({
          id: caseLawSources.id,
          adapterKey: caseLawSources.adapterKey,
        })
        .from(caseLawSources)
        .where(inArray(caseLawSources.adapterKey, ordered)),
  );
  const sourceByAdapter = new Map(
    availableSources.map((source) => [source.adapterKey, source]),
  );
  // The cheap per-source reads run once for every source; only the lag probe
  // and the budget check stay lazy, per candidate, in the walk below.
  const gateNames = ordered.flatMap((adapterKey) => {
    const source = sourceByAdapter.get(adapterKey);
    return source === undefined
      ? []
      : [
          checkpointName({
            id: source.id,
            currentParserVersion: PARSER_VERSIONS[adapterKey],
          }),
        ];
  });
  const { gateStates, pendingSourceIds } = await withReplayTransaction(
    db,
    async (tx) => {
      const gateRows =
        gateNames.length === 0
          ? []
          : await tx
              .select()
              .from(databaseBackfillStates)
              .where(inArray(databaseBackfillStates.name, gateNames));
      const pendingRows =
        availableSources.length === 0
          ? []
          : await tx
              .selectDistinct({ sourceId: caseLawReplayBatches.sourceId })
              .from(caseLawReplayBatches)
              .where(
                and(
                  inArray(
                    caseLawReplayBatches.sourceId,
                    availableSources.map((source) => source.id),
                  ),
                  inArray(caseLawReplayBatches.status, [
                    "reserved",
                    "retry-exhausted",
                  ]),
                  or(
                    isNull(caseLawReplayBatches.retryAt),
                    lte(
                      caseLawReplayBatches.retryAt,
                      sql`${new Date(now())}::timestamptz`,
                    ),
                  ),
                ),
              );
      return {
        gateStates: new Map(
          gateRows.map((row) => [row.name, decodeCheckpoint(row).batch]),
        ),
        pendingSourceIds: new Set(pendingRows.map((row) => row.sourceId)),
      };
    },
  );
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
      const source = sourceByAdapter.get(adapterKey);
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
      const state = gateStates.get(checkpointName(candidate)) ?? {
        ...initialBatchState(),
        size: 1,
      };
      if (state.holdUntil !== null && state.holdUntil > now()) {
        context.onHeld?.(candidate, state);
        return null;
      }
      const pending = pendingSourceIds.has(source.id);
      let probe = pending;
      if (!pending) {
        // db-await-in-loop: Only probe lag after this source has no pending receipt, before advancing to the next source in round-robin order.
        probe = await withReplayTransaction(
          db,
          async (tx) =>
            (
              await buildBackgroundReplayProbe(tx, {
                sourceId: candidate.id,
                currentParserVersion: candidate.currentParserVersion,
                mode: candidate.mode,
              })
            ).length > 0,
        );
      }
      if (!probe) {
        return null;
      }
      onLag?.(candidate);
      if (
        // db-await-in-loop: Check allowance only for a lagging candidate, stopping the ordered source walk immediately when one is eligible.
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
    mode: source.mode,
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
  { db, now }: ReplayStoreContext,
  { source, after }: PreviewBatchOptions,
): Promise<BackgroundReplayReservation | { type: "waiting" }> =>
  await withReplayTransaction(db, async (tx) => {
    // Preview and apply serialize their shared source/day allowance here.
    await lockCheckpoint(tx, source);
    const persisted =
      after ??
      (
        await tx
          .select({ cursor: databaseBackfillStates.cursor })
          .from(databaseBackfillStates)
          .where(eq(databaseBackfillStates.name, previewCheckpointName(source)))
          .limit(1)
      ).at(0)?.cursor ??
      null;
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
    if (row === null) {
      return { type: "empty" };
    }
    const utcDay = new Date(now()).toISOString().slice(0, 10);
    const id = `${source.id}:${source.currentParserVersion}:${row.id}${BACKGROUND_REPLAY_PREVIEW_SUFFIX}`;
    const receipt = (
      await tx
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.id, id))
        .for("update")
        .limit(1)
    ).at(0);
    if (receipt?.retryAt && receipt.retryAt.getTime() > now()) {
      return { type: "waiting" };
    }
    if (receipt?.failed === 0 && receipt.budgetDay === utcDay) {
      // Wrapping or resetting the cursor cannot repeat successful inspection
      // on an already charged row during the same UTC day.
      return { type: "empty" };
    }
    const attempts = receipt?.failed === 1 ? receipt.attempts + 1 : 1;
    const retryDelay = backoffDelay(attempts - 1, {
      baseMs: BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs,
      maxMs: BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
    });
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
    const charged =
      (
        await tx
          .select({ id: caseLawReplayDailyRows.batchId })
          .from(caseLawReplayDailyRows)
          .where(
            and(
              eq(caseLawReplayDailyRows.batchId, id),
              eq(caseLawReplayDailyRows.budgetDay, utcDay),
            ),
          )
          .limit(1)
      ).length > 0;
    if (!charged && usage >= source.dailyBudget) {
      return { type: "budget-exhausted" };
    }
    // Preview bookkeeping has a separate identity and stays terminal in the
    // apply receipt lifecycle, including for workers deployed before this code.
    // Its attempt/retry fields recover failed or interrupted inspections.
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
        status: "completed",
        attempted: 1,
        failed: 1,
        attempts,
        retryAt: new Date(now() + retryDelay),
        failureCode: "tick-cancelled",
        failureMessageClass: "cancelled",
        gateVerdict: { kind: "normal", signals: [] },
        completedAt: new Date(now()),
      })
      .onConflictDoUpdate({
        target: caseLawReplayBatches.id,
        set: {
          budgetDay: utcDay,
          failed: 1,
          attempts,
          retryAt: new Date(now() + retryDelay),
          failureCode: "tick-cancelled",
          failureMessageClass: "cancelled",
          outcome: null,
          completedAt: new Date(now()),
        },
      });
    if (!(await admitDailyRow(tx, { source, batchId: id, utcDay }))) {
      return panic("Preview budget changed under checkpoint lock");
    }
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "receipt-reserved",
      resourceId: id,
      details: { mode: "dry-run", attempts },
      createdAt: new Date(now()),
    });
    return {
      type: "reserved",
      batch: {
        id,
        source,
        decisionId: row.id,
        parserVersionFrom: row.parserVersion,
        targetParserVersion: source.currentParserVersion,
      },
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
  cursor: string | null;
};

const pendingInTransaction = async (
  tx: Transaction,
  { source, utcDay, now, cursor }: PendingInTransactionOptions,
) => {
  const row = (
    await tx
      .select()
      .from(caseLawReplayBatches)
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          inArray(caseLawReplayBatches.status, ["reserved", "retry-exhausted"]),
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
        ...(cursor === null
          ? []
          : [
              sql`CASE WHEN ${caseLawReplayBatches.firstDecisionId} > ${cursor}::uuid THEN 0 ELSE 1 END`,
            ]),
        asc(caseLawReplayBatches.firstDecisionId),
        asc(caseLawReplayBatches.id),
      )
      .limit(1)
  ).at(0);
  if (!row) {
    return { type: "empty" } as const;
  }
  if (
    row.status === "reserved" &&
    (row.systemicFailures > 0 ||
      row.failureCode === "tick-deadline" ||
      row.failureCode === "tick-cancelled")
  ) {
    const cursorRow =
      cursor === null
        ? null
        : (
            await tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, sql`${cursor}::uuid`))
              .limit(1)
          ).at(0);
    if (await selectNext(tx, { source, after: cursorRow?.id ?? null })) {
      return { type: "empty" } as const;
    }
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
  if (row.status === "retry-exhausted") {
    // The checkpoint lock serializes readmission and daily budget admission.
    await tx
      .update(caseLawReplayBatches)
      .set({
        status: "reserved",
        readmissions: row.readmissions + 1,
        attempts: 0,
        systemicFailures: 0,
        systemicProgress: 0,
        attemptState: "idle",
        failed: 0,
        retryAt: null,
        completedAt: null,
      })
      .where(eq(caseLawReplayBatches.id, row.id));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source.id,
      action: "receipt-reserved",
      resourceId: row.id,
      details: {
        readmissions: row.readmissions + 1,
        failureCode:
          row.failureCode ?? panic("Exhausted replay has no failure code"),
      },
      createdAt: new Date(now),
    });
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
  if (state === undefined) {
    panic("Replay checkpoint was not created");
  }
  return { ...state, batch: decodeCheckpoint(state).batch };
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
    const state = await lockCheckpoint(tx, source);
    return await pendingInTransaction(tx, {
      source,
      utcDay,
      now: now(),
      cursor: state.cursor,
    });
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
    return row === undefined
      ? { ...initialBatchState(), size: 1 }
      : decodeCheckpoint(row).batch;
  });
type SaveGateStateOptions = {
  source: BackgroundReplaySource | null;
  batch: BatchState;
};

const saveGateState = async (
  { db, now }: ReplayStoreContext,
  { source, batch }: SaveGateStateOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    const name =
      source === null ? PREFLIGHT_CHECKPOINT : checkpointName(source);
    // maintenance pacing state has no tenant or document mutation
    await tx
      .insert(databaseBackfillStates)
      .values({ name, batch })
      .onConflictDoUpdate({
        target: databaseBackfillStates.name,
        set: { batch, updatedAt: new Date(now()) },
      });
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: source?.id,
      action: "gate-state-saved",
      resourceId: name,
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
      cursor: state.cursor,
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
type ExhaustedRetryStateOptions = { readmissions: number; now: number };

const exhaustedRetryState = ({
  readmissions,
  now,
}: ExhaustedRetryStateOptions) =>
  readmissions >= BACKGROUND_REPLAY_LIMITS.maxRowReadmissions
    ? ({
        status: "retry-terminal",
        retryAt: null,
        completedAt: new Date(now),
      } as const)
    : ({
        status: "retry-exhausted",
        retryAt: new Date(now + BACKGROUND_REPLAY_LIMITS.rowReadmissionDelayMs),
        completedAt: null,
      } as const);

const pickUpBatch = async (
  { db, now }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
): Promise<"ready" | "retry-exhausted" | "retry-terminal" | "waiting"> =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    const receipt =
      (
        await tx
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, batch.id))
          .for("update")
          .limit(1)
      ).at(0) ?? panic("Replay pickup has no reservation");
    if (
      receipt.status !== "reserved" ||
      (receipt.retryAt !== null && receipt.retryAt.getTime() > now())
    ) {
      return "waiting";
    }
    if (receipt.attempts >= BACKGROUND_REPLAY_LIMITS.maxRowAttempts) {
      const decision = (
        await tx
          .select({ parserVersion: caseLawDecisions.parserVersion })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, batch.decisionId))
          .limit(1)
      ).at(0);
      // A written row can still need its canonical mirror repaired. Recovery
      // verifies completion without spending another row-specific attempt.
      if ((decision?.parserVersion ?? -1) >= batch.targetParserVersion) {
        return "ready";
      }
      const retryState = exhaustedRetryState({
        readmissions: receipt.readmissions,
        now: now(),
      });
      const failureCode = receipt.failureCode ?? "unexpected";
      await tx
        .update(caseLawReplayBatches)
        .set({
          ...retryState,
          attemptState: "idle",
          failureCode,
          failed: 1,
        })
        .where(eq(caseLawReplayBatches.id, batch.id));

      const { status } = retryState;
      await recordReplayMaintenanceAuditEvent(tx, {
        sourceId: batch.source.id,
        action: "receipt-failed",
        resourceId: batch.id,
        details: {
          status,
          readmissions: receipt.readmissions,
          failureCode,
        },
        createdAt: new Date(now()),
      });
      logger.warn("case_law_replay.retry_exhausted", {
        batchId: batch.id,
        status,
        readmissions: receipt.readmissions,
        failureCode,
      });
      return status;
    }
    const attempts = receipt.attempts + 1;
    const delay = backoffDelay(attempts - 1, {
      baseMs: BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs,
      maxMs: BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
    });
    await tx
      .update(caseLawReplayBatches)
      .set({
        attempts,
        attemptState: "picked-up",
        retryAt: new Date(now() + delay),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    return "ready";
  });

type CompleteBatchOptions = {
  batch: BackgroundReplayBatch;
  report: ReplayRowReport;
  durationMs: number;
  verdict: Verdict;
  healthyEvidence?: "adjacent-row" | "none";
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
    .values({
      sourceId,
      ticksWithoutProgress: 0,
      lastCompletedAt: completedAt,
      completedRows: 1,
    })
    .onConflictDoUpdate({
      target: caseLawReplaySourceProgress.sourceId,
      set: {
        ticksWithoutProgress: 0,
        lastCompletedAt: completedAt,
        completedRows: sql`${caseLawReplaySourceProgress.completedRows} + 1`,
      },
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
  scope: ReplayFailure["scope"];
  healthyEvidence: "adjacent-row" | "none";
  messageClass: ReplayFailure["messageClass"];
  haltReason?: string;
  durationMs: number;
  verdict: Verdict;
};

type ClassifyReplayFailureOptions = {
  receipt: Pick<
    typeof caseLawReplayBatches.$inferSelect,
    "attemptState" | "attempts" | "systemicFailures" | "systemicProgress"
  >;
  failure: Pick<ReplayFailureOptions, "scope" | "code" | "healthyEvidence">;
  progress: number;
};

const classifyReplayFailure = ({
  receipt,
  failure,
  progress,
}: ClassifyReplayFailureOptions) => {
  // Fresh verified progress distinguishes an isolated row from an outage.
  // Each conversion resets its baseline, so old success cannot spend later
  // outage attempts; cancellation and duplicate persistence never count.
  const countSystemic =
    failure.scope === "systemic" &&
    receipt.attemptState === "picked-up" &&
    failure.code !== "tick-deadline" &&
    failure.code !== "tick-cancelled";
  const baseline =
    receipt.systemicFailures === 0 ? progress : receipt.systemicProgress;
  const systemicFailures = countSystemic
    ? Math.min(
        REPLAY_SYSTEMIC_ISOLATION_THRESHOLD,
        receipt.systemicFailures + 1,
      )
    : receipt.systemicFailures;
  const isolated =
    countSystemic &&
    systemicFailures >= REPLAY_SYSTEMIC_ISOLATION_THRESHOLD &&
    (progress > baseline || failure.healthyEvidence === "adjacent-row");
  const effectiveScope = isolated ? "row" : failure.scope;
  const attempts =
    effectiveScope === "systemic" && receipt.attemptState === "picked-up"
      ? Math.max(0, receipt.attempts - 1)
      : receipt.attempts;
  return {
    isolated,
    effectiveScope,
    attempts,
    systemicFailures: isolated ? 0 : systemicFailures,
    systemicProgress: isolated ? progress : baseline,
  };
};

const recordPreviewFailure = async (
  { db, now }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
  failure: ReplayFailureOptions,
): Promise<"retryable" | "failed"> =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    const receipt =
      (
        await tx
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, batch.id))
          .for("update")
          .limit(1)
      ).at(0) ?? panic("Preview failure has no reservation");
    // Admission spends an attempt before inspection; outages cannot spend
    // the row's bounded failure allowance.
    const attempts =
      failure.scope === "systemic"
        ? Math.max(0, receipt.attempts - 1)
        : receipt.attempts;
    const exhausted =
      failure.scope === "row" &&
      attempts >= BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
    const delay = backoffDelay(Math.max(0, attempts - 1), {
      baseMs: BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs,
      maxMs: BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
    });
    await tx
      .update(caseLawReplayBatches)
      .set({
        attempts,
        failed: 1,
        retryAt: exhausted ? null : new Date(now() + delay),
        failureCode: failure.code,
        failureMessageClass: failure.messageClass,
        outcome: exhausted
          ? REPLAY_PREVIEW_FAILURE.RETRY_EXHAUSTED
          : REPLAY_ROW_OUTCOME.RETRYABLE,
        durationMs: Math.ceil(failure.durationMs),
        gateVerdict: failure.verdict,
        completedAt: new Date(now()),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: batch.source.id,
      action: "receipt-failed",
      resourceId: batch.id,
      details: {
        mode: "dry-run",
        attempts,
        failureCode: failure.code,
      },
      createdAt: new Date(now()),
    });
    if (exhausted) {
      await advancePreviewCursor(tx, {
        batch,
        completedAt: new Date(now()),
        kind: "retry-exhausted",
      });
    }
    return exhausted ? "failed" : "retryable";
  });

const recordFailure = async (
  { db, now, beforeComplete }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
  failure: ReplayFailureOptions,
): Promise<
  | "retryable"
  | "failed"
  | "applied"
  | "isolated"
  | "retry-exhausted"
  | "retry-terminal"
> => {
  await beforeComplete?.();
  return await withReplayTransaction(db, async (tx) => {
    const checkpoint = await lockCheckpoint(tx, batch.source);
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
    const progress =
      (
        await tx
          .select({ completedRows: caseLawReplaySourceProgress.completedRows })
          .from(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, batch.source.id))
          .limit(1)
      ).at(0)?.completedRows ?? 0;
    const {
      isolated,
      effectiveScope,
      attempts,
      systemicFailures,
      systemicProgress,
    } = classifyReplayFailure({ receipt, failure, progress });
    const decision = (
      await tx
        .select({
          parserVersion: caseLawDecisions.parserVersion,
          redactedAt: caseLawDecisions.redactedAt,
          corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, batch.decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    if (
      decision?.redactedAt === null &&
      decision.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
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
          attemptState: "idle",
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
      await tx
        .insert(caseLawReplayBlocked)
        .values({
          sourceId: batch.source.id,
          decisionId: batch.decisionId,
          parserVersionFrom: batch.parserVersionFrom,
          parserVersionTo: batch.targetParserVersion,
          outcome: "changed",
          reason: null,
        })
        .onConflictDoNothing();
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
    const exhausted =
      effectiveScope === "row" &&
      attempts >= BACKGROUND_REPLAY_LIMITS.maxRowAttempts;
    const retryDelay = backoffDelay(Math.max(0, attempts - 1), {
      baseMs: BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs,
      maxMs: BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
    });
    const retryState = exhausted
      ? exhaustedRetryState({ readmissions: receipt.readmissions, now: now() })
      : ({
          status: "reserved",
          retryAt: new Date(now() + retryDelay),
          completedAt: null,
        } as const);
    // persists bounded owner-only retry state before advancing the sweep
    await tx
      .update(caseLawReplayBatches)
      .set({
        attempts,
        systemicFailures,
        systemicProgress,
        attemptState: "idle",
        failed: 1,
        ...retryState,
        failureCode: failure.code,
        failureMessageClass: failure.messageClass,
        outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
        durationMs: Math.ceil(failure.durationMs),
        gateVerdict: failure.verdict,
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    const systemicHoldCount = checkpoint.batch.holdCount + 1;
    const sourceDelay = backoffDelay(Math.min(16, systemicHoldCount - 1), {
      baseMs: BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs,
      maxMs: BACKGROUND_REPLAY_LIMITS.rowRetryMaxMs,
    });
    const sourceBatch =
      effectiveScope === "systemic"
        ? {
            ...checkpoint.batch,
            holdCount: systemicHoldCount,
            heldSince: checkpoint.batch.heldSince ?? now(),
            holdCause: "other" as const,
            holdUntil: now() + sourceDelay,
          }
        : checkpoint.batch;
    // failed row is durably queued or excluded before later work
    await tx
      .update(databaseBackfillStates)
      .set({
        cursor: batch.decisionId,
        batch: sourceBatch,
        updatedAt: new Date(now()),
      })
      .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId: batch.source.id,
      action: "receipt-failed",
      resourceId: batch.id,
      details: {
        attempts,
        readmissions: receipt.readmissions,
        status: retryState.status,
        failureCode: failure.code,
      },
      createdAt: new Date(now()),
    });
    if (exhausted) {
      const { status } = exhaustedRetryState({
        readmissions: receipt.readmissions,
        now: now(),
      });
      logger.warn("case_law_replay.retry_exhausted", {
        batchId: batch.id,
        status,
        readmissions: receipt.readmissions,
        failureCode: failure.code,
      });
      return status;
    }
    return isolated ? "isolated" : "retryable";
  });
};

type CheckedReplayCompletion =
  | { type: "terminal"; receipt: ReplayRowResult }
  | { type: "retryable" }
  | { type: "blocked" };
type CheckReplayCompletionOptions = {
  batch: BackgroundReplayBatch;
  report: ReplayRowReport;
  decision:
    | (Pick<
        typeof caseLawDecisions.$inferSelect,
        "parserVersion" | "redactedAt" | "corpusMirrorStatus"
      > & { updateToken: string })
    | undefined;
};
const checkReplayCompletion = ({
  batch,
  report,
  decision,
}: CheckReplayCompletionOptions): CheckedReplayCompletion => {
  if (decision?.redactedAt !== null) {
    return { type: "blocked" };
  }
  const moved = (decision.parserVersion ?? -1) >= batch.targetParserVersion;
  const receipt = replayRowResult(
    moved ? { ...report, outcome: REPLAY_ROW_OUTCOME.APPLIED } : report,
    batch.targetParserVersion,
  );
  if (receipt === null) {
    return { type: "retryable" };
  }
  // A changed receipt is terminal only once the row reached the target version.
  if (receipt.outcome === "changed" && !moved) {
    return { type: "retryable" };
  }
  if (
    receipt.outcome === "unchanged" &&
    (decision.parserVersion !== batch.parserVersionFrom ||
      report.checkedUpdateToken === undefined ||
      decision.updateToken !== report.checkedUpdateToken)
  ) {
    return { type: "retryable" };
  }
  if (
    receipt.outcome !== "rejected" &&
    decision.corpusMirrorStatus !== CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED
  ) {
    return { type: "retryable" };
  }
  return { type: "terminal", receipt };
};
const completionDisposition = (receipt: ReplayRowResult | null) => {
  switch (receipt?.outcome) {
    case "changed":
      return "applied";
    case "unchanged":
      return "unchanged";
    case "rejected":
    case undefined:
      return "blocked";
    default:
      receipt satisfies never;
      return panic("Unknown replay receipt outcome");
  }
};
const COMPLETION_REPORT_OUTCOME = {
  applied: REPLAY_ROW_OUTCOME.APPLIED,
  unchanged: REPLAY_ROW_OUTCOME.UNCHANGED,
  blocked: REPLAY_ROW_OUTCOME.REJECTED,
} as const satisfies Record<
  ReturnType<typeof completionDisposition>,
  ReplayRowReport["outcome"]
>;

const completeBatch = async (
  context: ReplayStoreContext,
  {
    batch,
    report,
    durationMs,
    verdict,
    healthyEvidence = "none",
  }: CompleteBatchOptions,
): Promise<
  | "applied"
  | "blocked"
  | "unchanged"
  | "retryable"
  | "isolated"
  | "failed"
  | "retry-exhausted"
  | "retry-terminal"
> => {
  const { db, now, beforeCheckpoint, beforeComplete } = context;
  if (report.id !== batch.decisionId) {
    panic("Replay report does not match its reservation");
  }
  if (report.outcome === REPLAY_ROW_OUTCOME.RETRYABLE) {
    const failure = await recordFailure(context, batch, {
      ...replayFailure("writer-retryable"),
      healthyEvidence,
      durationMs,
      verdict,
    });
    return failure;
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
  const disposition = await withReplayTransaction(db, async (tx) => {
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
      if (receipt.outcome === REPLAY_ROW_OUTCOME.UNCHANGED) {
        return "unchanged";
      }
      return receipt.applied > 0 ? "applied" : "blocked";
    }
    const decision = (
      await tx
        .select({
          parserVersion: caseLawDecisions.parserVersion,
          updateToken: sql<string>`${caseLawDecisions.updatedAt}::text`,
          redactedAt: caseLawDecisions.redactedAt,
          corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, batch.decisionId))
        .for("update")
        .limit(1)
    ).at(0);
    const completion = checkReplayCompletion({ batch, report, decision });
    if (completion.type === "retryable") {
      return "retryable-completion";
    }
    const terminal = completion.type === "terminal" ? completion.receipt : null;
    if (terminal !== null) {
      const reason = terminal.outcome === "rejected" ? terminal.reason : null;
      await tx
        .insert(caseLawReplayBlocked)
        .values({
          sourceId: batch.source.id,
          decisionId: terminal.decisionId,
          parserVersionFrom: batch.parserVersionFrom,
          parserVersionTo: terminal.targetParserVersion,
          outcome: terminal.outcome,
          reason,
          detail: reason,
        })
        .onConflictDoNothing();
    }
    const rowDisposition = completionDisposition(terminal);
    const successful = rowDisposition !== "blocked";
    // A recovered write is applied even when the replay reports unchanged.
    // Changed rows require the parser stamp; unchanged rows retain their stamp
    // and are fenced by the exact checked input token. Both settle the receipt.
    await tx
      .update(caseLawReplayBatches)
      .set({
        status: successful ? "completed" : "blocked",
        outcome: COMPLETION_REPORT_OUTCOME[rowDisposition],
        applied: Number(rowDisposition === "applied"),
        blocked: Number(!successful),
        failed: 0,
        attempts: receipt.attempts,
        attemptState: "idle",
        retryAt: null,
        durationMs: Math.ceil(durationMs),
        gateVerdict: verdict,
        completedAt: new Date(now()),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    if (successful) {
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
      action: successful ? "receipt-applied" : "receipt-blocked",
      resourceId: batch.id,
      details: {
        attempts: receipt.attempts,
        status: successful ? "completed" : "blocked",
      },
      createdAt: new Date(now()),
    });
    return rowDisposition;
  });
  if (disposition === "retryable-completion") {
    const failure = await recordFailure(context, batch, {
      ...replayFailure("writer-retryable"),
      healthyEvidence,
      durationMs,
      verdict,
    });
    return failure;
  }
  return disposition;
};

type AdvancePreviewCursorOptions = {
  batch: BackgroundReplayBatch;
  completedAt: Date;
  kind: NonNullable<ReplayMaintenanceAuditDetails["kind"]>;
};

const advancePreviewCursor = async (
  tx: Transaction,
  { batch, completedAt, kind }: AdvancePreviewCursorOptions,
) => {
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
      set: { cursor: batch.decisionId, updatedAt: completedAt },
    });
  await recordReplayMaintenanceAuditEvent(tx, {
    sourceId: batch.source.id,
    action: "dry-run-advanced",
    resourceId: previewCheckpointName(batch.source),
    details: { kind },
    createdAt: completedAt,
  });
};

const advancePreview = async (
  { db, now }: ReplayStoreContext,
  batch: BackgroundReplayBatch,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    await tx
      .update(caseLawReplayBatches)
      .set({
        failed: 0,
        failureCode: null,
        failureMessageClass: null,
        outcome: null,
        retryAt: null,
        completedAt: new Date(now()),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    await advancePreviewCursor(tx, {
      batch,
      completedAt: new Date(now()),
      kind: "reviewed",
    });
  });

const resetDryRunCursor = async (
  { db, now }: ReplayStoreContext,
  source: BackgroundReplaySource,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, source);
    // Keep daily charges and receipt identity while re-admitting exhausted
    // previews for this source and parser version.
    await tx
      .update(caseLawReplayBatches)
      .set({
        attempts: 0,
        outcome: null,
        retryAt: null,
        failureCode: null,
        failureMessageClass: null,
      })
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          eq(caseLawReplayBatches.parserVersionTo, source.currentParserVersion),
          eq(
            caseLawReplayBatches.outcome,
            REPLAY_PREVIEW_FAILURE.RETRY_EXHAUSTED,
          ),
          sql`${caseLawReplayBatches.id} LIKE ${`${escapeLike(`${source.id}:${source.currentParserVersion}:`)}%${escapeLike(BACKGROUND_REPLAY_PREVIEW_SUFFIX)}`}`,
        ),
      );
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

type ReplayCompactionQueryOptions = { cutoff: Date; limit: number };
export const buildReplayCompactionQuery = (
  tx: Transaction,
  { cutoff, limit }: ReplayCompactionQueryOptions,
) =>
  tx
    .select({
      id: caseLawReplayBatches.id,
      sourceId: caseLawReplayBatches.sourceId,
      decisionId: caseLawReplayBatches.firstDecisionId,
      parserVersionTo: caseLawReplayBatches.parserVersionTo,
    })
    .from(caseLawReplayBatches)
    .where(
      and(
        isNotNull(caseLawReplayBatches.supersededAt),
        lte(caseLawReplayBatches.supersededAt, sql`${cutoff}::timestamptz`),
      ),
    )
    .orderBy(
      asc(caseLawReplayBatches.supersededAt),
      asc(caseLawReplayBatches.id),
    )
    .limit(limit)
    .for("update");

export const buildReplayRetirementQuery = (tx: Transaction, limit: number) => {
  const staleReceipts = tx
    .select({ id: caseLawReplayBatches.id })
    .from(caseLawReplayBatches)
    .where(
      and(
        eq(caseLawReplayBatches.sourceId, caseLawSources.id),
        lt(
          caseLawReplayBatches.parserVersionTo,
          sql`current_parsers.parser_version`,
        ),
        isNull(caseLawReplayBatches.supersededAt),
        inArray(caseLawReplayBatches.status, [
          "completed",
          "superseded",
          "failed",
          "retry-exhausted",
          "retry-terminal",
          "blocked",
        ]),
      ),
    )
    .orderBy(
      asc(caseLawReplayBatches.parserVersionTo),
      asc(caseLawReplayBatches.id),
    )
    .limit(limit)
    .as("stale_receipts");
  return tx
    .select({ id: staleReceipts.id })
    .from(caseLawSources)
    .innerJoin(
      sql`(VALUES ${sql.join(
        Object.entries(PARSER_VERSIONS).map(
          ([key, version]) => sql`(${key}::text, ${version}::int)`,
        ),
        sql`, `,
      )}) AS current_parsers(adapter_key, parser_version)`,
      eq(caseLawSources.adapterKey, sql`current_parsers.adapter_key`),
    )
    .innerJoinLateral(staleReceipts, sql`true`)
    .limit(limit);
};

const compact = async ({ db, now }: ReplayStoreContext, limit: number) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > BACKGROUND_REPLAY_LIMITS.maxCompactRows
  ) {
    panic("Replay compaction limit must be a bounded positive integer");
  }
  return await withReplayTransaction(db, async (tx) => {
    const stale = buildReplayRetirementQuery(tx, limit);
    // Discover older terminal generations independently of new reservations.
    await tx
      .update(caseLawReplayBatches)
      .set({
        supersededAt: sql`coalesce(${caseLawReplayBatches.completedAt}, now())`,
      })
      .where(inArray(caseLawReplayBatches.id, stale));
    const old = await buildReplayCompactionQuery(tx, {
      cutoff: new Date(
        now() - BACKGROUND_REPLAY_LIMITS.receiptRetentionDays * DAY_IN_MS,
      ),
      limit,
    });
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
  // One system audit row per tick that changed anything, dry runs included:
  // this module's writes are attributed to the replay actor's run.
  await withReplayTransaction(db, async (tx) => {
    await recordSystemAudit(tx, "system:case-law-background-replay", {
      subject: createSafeId<"systemScriptRun">(),
      counts: {
        attempted: report.attempted,
        applied: report.applied,
        blocked: report.blocked,
        failed: report.failed,
      },
    });
  });
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
      details: {
        ticksWithoutProgress: row.ticksWithoutProgress,
        retryExhausted: report.retryExhausted,
        retryTerminal: report.retryTerminal,
      },
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
    pickUpBatch: async (batch: BackgroundReplayBatch) =>
      await pickUpBatch(context, batch),
    loadPreflightGateState: async (): Promise<BatchState> =>
      await withReplayTransaction(db, async (tx) => {
        const row = (
          await tx
            .select()
            .from(databaseBackfillStates)
            .where(eq(databaseBackfillStates.name, PREFLIGHT_CHECKPOINT))
            .limit(1)
        ).at(0);
        return row === undefined
          ? initialBatchState()
          : decodeCheckpoint(row).batch;
      }),
    savePreflightGateState: async (batch: BatchState) =>
      await saveGateState(context, { source: null, batch }),
    recordTick: async (report: BackgroundReplayTickReport) =>
      await recordTick(context, report),
    recordFailure: async (
      batch: BackgroundReplayBatch,
      failure: ReplayFailureOptions,
    ) =>
      batch.source.mode === "dry-run"
        ? await recordPreviewFailure(context, batch, failure)
        : await recordFailure(context, batch, failure),
    advancePreview: async (batch: BackgroundReplayBatch) =>
      await advancePreview(context, batch),
    resetDryRunCursor: async (source: BackgroundReplaySource) =>
      await resetDryRunCursor(context, source),
    compact: async (limit: number = BACKGROUND_REPLAY_LIMITS.maxCompactRows) =>
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
