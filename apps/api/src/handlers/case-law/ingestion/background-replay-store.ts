import { panic } from "better-result";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

import {
  initialBatchState,
  type BatchState,
  type Verdict,
} from "@stll/db-load-gate/health";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  databaseBackfillStates,
} from "@/api/db/schema";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";

import { getAdapter } from "./adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplaySource,
} from "./background-replay";
import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_ROW_OUTCOME,
  replayCapability,
  selectReplayPage,
  selectScopeEnd,
  type ReplayRowReport,
} from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  type ReplayEnrolment,
} from "./replay-enrolment";

const withReplayTransaction = async <T>(
  db: CaseLawRootHandle,
  work: (tx: Transaction) => Promise<T>,
) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
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
};

type ReplayStoreContext = {
  db: CaseLawRootHandle;
  now: () => number;
  enrolment: Readonly<Record<keyof typeof PARSER_VERSIONS, ReplayEnrolment>>;
  onLag: ReplayStoreOptions["onLag"];
  onBudgetExhausted: ReplayStoreOptions["onBudgetExhausted"];
  beforeCheckpoint: ReplayStoreOptions["beforeCheckpoint"];
  sourceEnabled: ReplayStoreOptions["sourceEnabled"];
};

const hasDailyAllowance = async (
  db: CaseLawRootHandle,
  source: BackgroundReplaySource,
  utcDay: string,
) =>
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
          eq(caseLawReplayBatches.parserVersionTo, source.currentParserVersion),
          eq(caseLawReplayDailyRows.budgetDay, utcDay),
        ),
      )
      .limit(1);
    return recoverable.length > 0;
  });

const chooseSource = async ({
  db,
  enrolment,
  onLag,
  now,
  sourceEnabled,
  onBudgetExhausted,
}: ReplayStoreContext): Promise<BackgroundReplaySource | null> => {
  const sources: BackgroundReplaySource[] = [];
  for (const adapterKey of Object.values(ADAPTER_KEYS)) {
    const policy = enrolment[adapterKey];
    if (policy.mode === "off" || sourceEnabled?.(adapterKey) === false) {
      continue;
    }
    if (
      !Number.isSafeInteger(policy.dailyBudget) ||
      policy.dailyBudget <= 0 ||
      policy.dailyBudget > BACKGROUND_REPLAY_LIMITS.maxDailyBudget
    ) {
      panic("Replay daily budget must be a positive bounded integer");
    }
    if (
      policy.mode === "enrolled" &&
      policy.reviewedDryRun.trim().length === 0
    ) {
      panic("Replay enrolment requires a reviewed dry run");
    }
    const adapter = getAdapter(adapterKey);
    if (!adapter || replayCapability(adapter).type === "unsupported") {
      panic("Enrolled adapter cannot replay stored raw");
    }
    const version = PARSER_VERSIONS[adapterKey];
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
      continue;
    }
    const lag = await withReplayTransaction(db, async (tx) =>
      (
        await tx
          .select({
            rowsBehind: sql<number>`count(*)::int`,
            oldestAgeMs: sql<number>`greatest(coalesce(extract(epoch from (to_timestamp(${now() / 1000}) - min(${caseLawDecisions.createdAt}))) * 1000, 0), 0)::float8`,
            blockedCount: sql<number>`count(*) filter (where exists (select 1 from case_law_replay_blocked b where b.decision_id = ${caseLawDecisions.id} and b.parser_version_to = ${version}))::int`,
            replayable: sql<number>`count(*) filter (where ${caseLawDecisions.sourceRawS3Key} is not null and not exists (select 1 from case_law_replay_blocked b where b.decision_id = ${caseLawDecisions.id} and b.parser_version_to = ${version}))::int`,
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, source.id),
              isNull(caseLawDecisions.redactedAt),
              or(
                isNull(caseLawDecisions.parserVersion),
                lt(caseLawDecisions.parserVersion, version),
              ),
            ),
          )
      ).at(0),
    );
    const pending =
      (
        await withReplayTransaction(
          db,
          async (tx) =>
            await tx
              .select({ id: caseLawReplayBatches.id })
              .from(caseLawReplayBatches)
              .where(
                and(
                  eq(caseLawReplayBatches.sourceId, source.id),
                  eq(caseLawReplayBatches.status, "reserved"),
                ),
              )
              .limit(1),
        )
      ).length > 0;
    const candidate: BackgroundReplaySource = {
      id: source.id,
      adapterKey,
      currentParserVersion: version,
      dailyBudget: policy.dailyBudget,
      mode: policy.mode,
      rowsBehind: lag?.rowsBehind ?? 0,
      oldestAgeMs: lag?.oldestAgeMs ?? 0,
      blockedCount: lag?.blockedCount ?? 0,
    };
    onLag?.(candidate);
    if (!pending && (lag?.replayable ?? 0) === 0) {
      continue;
    }
    if (
      candidate.mode === "enrolled" &&
      !(await hasDailyAllowance(
        db,
        candidate,
        new Date(now()).toISOString().slice(0, 10),
      ))
    ) {
      onBudgetExhausted?.(candidate);
      continue;
    }
    sources.push(candidate);
  }
  sources.sort((a, b) => b.rowsBehind - a.rowsBehind);
  return sources.at(0) ?? null;
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
    const row = await selectNext(tx, { source, after });
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
  // audit: skip — accounts for one maintenance row per UTC day, including recovery
  await tx
    .insert(caseLawReplayDailyRows)
    .values({ batchId, sourceId: source.id, budgetDay: utcDay })
    .onConflictDoNothing();
  return true;
};
type PendingInTransactionOptions = {
  source: BackgroundReplaySource;
  utcDay: string;
};

const pendingInTransaction = async (
  tx: Transaction,
  { source, utcDay }: PendingInTransactionOptions,
) => {
  const row = (
    await tx
      .select()
      .from(caseLawReplayBatches)
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          eq(caseLawReplayBatches.status, "reserved"),
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
    // audit: skip — preserves the superseded reservation before current-parser work
    await tx
      .update(caseLawReplayBatches)
      .set({ status: "superseded", completedAt: sql`now()` })
      .where(eq(caseLawReplayBatches.id, row.id));
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
  // audit: skip — initializes owner-only maintenance checkpoint
  await tx
    .insert(databaseBackfillStates)
    .values({ name, batch: { ...initialBatchState(), size: 1 } })
    .onConflictDoNothing();
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
  { db }: ReplayStoreContext,
  { source, utcDay }: PendingBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, source);
    return await pendingInTransaction(tx, { source, utcDay });
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
    // audit: skip — maintenance pacing state has no tenant or document mutation
    await tx
      .insert(databaseBackfillStates)
      .values({ name: checkpointName(source), batch })
      .onConflictDoUpdate({
        target: databaseBackfillStates.name,
        set: { batch, updatedAt: new Date(now()) },
      });
  });
type ReserveBatchOptions = PendingBatchOptions & { verdict: Verdict };

const reserveBatch = async (
  { db }: ReplayStoreContext,
  { source, utcDay, verdict }: ReserveBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    const state = await lockCheckpoint(tx, source);
    const pending = await pendingInTransaction(tx, { source, utcDay });
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
    // audit: skip — deterministic maintenance reservation and daily budget charge
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
      return panic("Completed replay receipt still selected as lagging");
    }
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

const completeBatch = async (
  { db, now, beforeCheckpoint }: ReplayStoreContext,
  { batch, report, durationMs, verdict }: CompleteBatchOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, batch.source);
    const receipt = (
      await tx
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.id, batch.id))
        .for("update")
        .limit(1)
    ).at(0);
    if (!receipt) {
      panic("Replay completion has no reservation");
    }
    if (receipt.status === "completed") {
      return;
    }
    if (report.id !== batch.decisionId) {
      panic("Replay report does not match its reservation");
    }
    if (
      report.outcome !== REPLAY_ROW_OUTCOME.APPLIED &&
      report.outcome !== REPLAY_ROW_OUTCOME.UNCHANGED &&
      report.outcome !== REPLAY_ROW_OUTCOME.REJECTED &&
      report.outcome !== REPLAY_ROW_OUTCOME.MISSING_PAYLOAD &&
      report.outcome !== REPLAY_ROW_OUTCOME.RETRYABLE
    ) {
      panic("Background replay cannot complete a non-terminal apply outcome");
    }
    const blocked =
      report.outcome === REPLAY_ROW_OUTCOME.REJECTED ||
      report.outcome === REPLAY_ROW_OUTCOME.MISSING_PAYLOAD;
    if (blocked) {
      const reason =
        report.outcome === REPLAY_ROW_OUTCOME.MISSING_PAYLOAD
          ? "missing-payload"
          : report.rejection;
      if (reason === undefined) {
        panic("Replay rejection has no classified reason");
      }
      // audit: skip — owner-only terminal public-corpus maintenance receipt
      await tx
        .insert(caseLawReplayBlocked)
        .values({
          sourceId: batch.source.id,
          decisionId: batch.decisionId,
          parserVersionFrom: batch.parserVersionFrom,
          parserVersionTo: batch.targetParserVersion,
          reason,
        })
        .onConflictDoNothing();
    }
    if (report.outcome === REPLAY_ROW_OUTCOME.RETRYABLE) {
      return;
    }
    // audit: skip — settles maintenance reservation, idempotently
    await tx
      .update(caseLawReplayBatches)
      .set({
        status: "completed",
        outcome: report.outcome,
        applied: Number(report.outcome === REPLAY_ROW_OUTCOME.APPLIED),
        blocked: Number(blocked),
        durationMs: Math.ceil(durationMs),
        gateVerdict: verdict,
        completedAt: new Date(now()),
      })
      .where(eq(caseLawReplayBatches.id, batch.id));
    await beforeCheckpoint?.(tx);
    // audit: skip — advances only after the row outcome is durably terminal
    await tx
      .update(databaseBackfillStates)
      .set({ cursor: batch.decisionId, updatedAt: new Date(now()) })
      .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
  });

/** Owner-only state for a public-corpus maintenance task; no tenant data. */
export const createBackgroundReplayStore = ({
  db,
  now,
  enrolment = REPLAY_ENROLMENT,
  onLag,
  beforeCheckpoint,
  sourceEnabled,
  onBudgetExhausted,
}: ReplayStoreOptions) => {
  const context = {
    db,
    now,
    enrolment,
    onLag,
    beforeCheckpoint,
    sourceEnabled,
    onBudgetExhausted,
  };
  return {
    chooseSource: async () => await chooseSource(context),
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
