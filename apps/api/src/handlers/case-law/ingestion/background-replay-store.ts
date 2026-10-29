import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import {
  type BatchState,
  initialBatchState,
  type Verdict,
} from "@stll/db-load-gate/health";
import { sha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS } from "@stll/time";

import { decodeCheckpoint } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawReplayAuditEvents,
  caseLawReplayBatches,
  caseLawReplayBlocked,
  caseLawReplayDailyRows,
  caseLawReplayReportedDecisions,
  caseLawReplaySourceProgress,
  caseLawReplayVisitedQuotas,
  caseLawSources,
  databaseBackfillStates,
  type ReplayDryRunDiffSample,
  type ReplayMaintenanceAuditDetails,
} from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import {
  buildCaseLawReplayCompactionQuery,
  buildCaseLawReplayHintCompactionQuery,
  buildCaseLawReplayVisitedQuotaCompactionQuery,
  lockCaseLawDecisionRows,
  lockCaseLawReplayBatch,
  lockCaseLawReplayPendingBatch,
  lockCaseLawReplayVisitedQuota,
} from "@/api/lib/db/aggregate-lock";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionLifecycle } from "@/api/lib/db/transitions";
import { escapeLike } from "@/api/lib/escape-like";
import { recordReplayMaintenanceAuditEvent } from "@/api/lib/legal-search/case-law-replay-audit";
import {
  dueCaseLawReplayPendingReceipt,
  REPLAY_PENDING_RECEIPT_STATUSES,
} from "@/api/lib/legal-search/case-law-replay-pending";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { logger } from "@/api/lib/observability/logger";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import { getAdapter } from "./adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplayReservation,
  BackgroundReplaySource,
  BackgroundReplayTickReport,
} from "./background-replay";
import {
  BACKGROUND_REPLAY_PREVIEW_SUFFIX,
  buildBackgroundReplayProbe,
  canReadmitReplayBatch,
  CASE_LAW_REPLAY_SCOPE,
  parsedReplayInputPredicate,
  REPLAY_ROW_OUTCOME,
  replayCapability,
  type ReplayDecisionRow,
  replayReadmissionInputPredicate,
  type ReplayRowReport,
  type ReplayRowResult,
  replayRowResult,
  replaySelectionPredicate,
  selectReplayPage,
  selectScopeEnd,
} from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  type ReplayEnrolment,
  replayWaveAdmission,
} from "./replay-enrolment";
import {
  REPLAY_PREVIEW_FAILURE,
  type ReplayFailure,
  replayFailure,
} from "./replay-failure";
import {
  REPLAY_HINT_TIERS,
  REPLAY_PRIORITY,
  replayPriorityRank,
  replaySourcePriorityOrder,
  VISITED_REPLAY_ADMISSION_LIMITS,
} from "./replay-priority";

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
  sourceRawS3Key: row.sourceRawS3Key,
  claimReadmission: row.readmissions,
});

const replayReservationPredicate = (batch: BackgroundReplayBatch) =>
  and(
    eq(caseLawReplayBatches.id, batch.id),
    eq(caseLawReplayBatches.sourceId, batch.source.id),
    eq(caseLawReplayBatches.readmissions, batch.claimReadmission),
    batch.sourceRawS3Key === null
      ? isNull(caseLawReplayBatches.sourceRawS3Key)
      : eq(caseLawReplayBatches.sourceRawS3Key, batch.sourceRawS3Key),
  );

const generationBatchId = (
  source: BackgroundReplaySource,
  row: Pick<ReplayDecisionRow, "id" | "sourceRawS3Key">,
) =>
  `${source.id}:${source.currentParserVersion}:${row.id}:${sha256Hex(row.sourceRawS3Key)}`;

const lockReplayDecisionInput = async (
  tx: Transaction,
  batch: Pick<
    BackgroundReplayBatch,
    "decisionId" | "source" | "targetParserVersion"
  >,
) => {
  await lockCaseLawDecisionRows({ tx, decisionIds: [batch.decisionId] });
  return (
    await tx
      .select({
        parserVersion: caseLawDecisions.parserVersion,
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        redactedAt: caseLawDecisions.redactedAt,
        corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
        parsedInputCurrent: parsedReplayInputPredicate(
          batch.targetParserVersion,
        ),
        readmissionEligible: replayReadmissionInputPredicate(
          batch.targetParserVersion,
        ),
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, batch.decisionId),
          eq(caseLawDecisions.sourceId, batch.source.id),
        ),
      )
      .limit(1)
  ).at(0);
};

type ReplayStoreOptions = {
  db: CaseLawRootHandle;
  now: () => number;
  enrolment?: Readonly<Record<keyof typeof PARSER_VERSIONS, ReplayEnrolment>>;
  onLag?: (source: BackgroundReplaySource) => void;
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
  beforeCheckpoint: ReplayStoreOptions["beforeCheckpoint"];
  sourceEnabled: ReplayStoreOptions["sourceEnabled"];
  beforeComplete: ReplayStoreOptions["beforeComplete"];
  gate: ReplayStoreOptions["gate"];
  onHeld: ReplayStoreOptions["onHeld"];
};

const ROUND_ROBIN_CHECKPOINT = "case-law-replay:round-robin";
const previewCheckpointName = (source: BackgroundReplaySource) =>
  `${checkpointName(source)}:dry-run`;

const markFullReplayCompleted = async (
  { db, now }: ReplayStoreContext,
  source: BackgroundReplaySource,
) => {
  if (source.mode !== "enrolled") {
    return;
  }
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, source);
    const pending = await tx
      .select({ id: caseLawReplayBatches.id })
      .from(caseLawReplayBatches)
      .where(
        and(
          eq(caseLawReplayBatches.sourceId, source.id),
          eq(caseLawReplayBatches.parserVersionTo, source.currentParserVersion),
          inArray(caseLawReplayBatches.status, REPLAY_PENDING_RECEIPT_STATUSES),
        ),
      )
      .limit(1);
    if (
      pending.length > 0 ||
      (
        await buildBackgroundReplayProbe(tx, {
          sourceId: source.id,
          adapterKey: source.adapterKey,
          currentParserVersion: source.currentParserVersion,
          mode: source.mode,
        })
      ).length > 0
    ) {
      return;
    }
    await tx
      .insert(caseLawReplaySourceProgress)
      .values({
        sourceId: source.id,
        lastFullReplayParserVersion: source.currentParserVersion,
        lastFullReplayAt: new Date(now()),
      })
      .onConflictDoUpdate({
        target: caseLawReplaySourceProgress.sourceId,
        set: {
          lastFullReplayParserVersion: source.currentParserVersion,
          lastFullReplayAt: new Date(now()),
        },
        where: sql`${caseLawReplaySourceProgress.lastFullReplayParserVersion} IS NULL OR ${caseLawReplaySourceProgress.lastFullReplayParserVersion} < ${source.currentParserVersion}`,
      });
  });
};

const readReplaySourcePriorities = async (
  { db }: ReplayStoreContext,
  ordered: readonly BackgroundReplaySource["adapterKey"][],
) => {
  const sources = await withReplayTransaction(
    db,
    async (tx) =>
      await tx
        .select({
          id: caseLawSources.id,
          adapterKey: caseLawSources.adapterKey,
          lastFullReplayParserVersion:
            caseLawReplaySourceProgress.lastFullReplayParserVersion,
        })
        .from(caseLawSources)
        .leftJoin(
          caseLawReplaySourceProgress,
          eq(caseLawReplaySourceProgress.sourceId, caseLawSources.id),
        )
        .where(inArray(caseLawSources.adapterKey, ordered)),
  );

  return sources;
};

type ReadReportedSourcesOptions = {
  sources: Awaited<ReturnType<typeof readReplaySourcePriorities>>;
  ordered: readonly BackgroundReplaySource["adapterKey"][];
  gateStates: ReadonlyMap<string, BatchState>;
};
const readReplayHintPriorities = async (
  { db, enrolment, now, sourceEnabled }: ReplayStoreContext,
  { sources, ordered, gateStates }: ReadReportedSourcesOptions,
) => {
  const candidates = ordered.flatMap((adapterKey) => {
    const policy = enrolment[adapterKey];
    const source = sources.find((row) => row.adapterKey === adapterKey);
    if (
      source === undefined ||
      policy.mode === "off" ||
      sourceEnabled?.(adapterKey) === false
    ) {
      return [];
    }
    if (
      replayWaveAdmission(policy, PARSER_VERSIONS[adapterKey]).status === "held"
    ) {
      return [];
    }
    const state = gateStates.get(
      checkpointName({
        id: source.id,
        currentParserVersion: PARSER_VERSIONS[adapterKey],
      }),
    );
    if (
      state?.holdUntil !== null &&
      state?.holdUntil !== undefined &&
      state.holdUntil > now()
    ) {
      return [];
    }
    return [
      {
        id: source.id,
        adapterKey,
        currentParserVersion: PARSER_VERSIONS[adapterKey],
        mode: policy.mode,
        rowsBehind: 1,
      },
    ];
  });
  const reported = await withReplayTransaction(db, async (tx) => {
    const [first, second, ...rest] = candidates.map((source) =>
      hintDecisionQuery(tx, {
        type: "source-priority",
        source,
        now: new Date(now()),
      }),
    );
    if (first === undefined) {
      return [];
    }
    return second === undefined
      ? await first
      : await unionAll(first, second, ...rest);
  });
  return new Map(reported.map((row) => [row.sourceId, row.tier]));
};

const chooseSource = async (
  context: ReplayStoreContext,
): Promise<BackgroundReplaySource | null> => {
  const { db, now, enrolment, onLag, sourceEnabled, gate } = context;
  if (gate) {
    const verdict = await gate();
    if (verdict.kind !== "normal" && verdict.kind !== "degraded") {
      return null;
    }
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
  const availableSources = await readReplaySourcePriorities(context, ordered);
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
                  dueCaseLawReplayPendingReceipt(new Date(now())),
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
  const reportedSources = await readReplayHintPriorities(context, {
    sources: availableSources,
    ordered,
    gateStates,
  });
  const priorityOrder = replaySourcePriorityOrder({
    adapterOrder: ordered,
    sources: availableSources,
    parserVersions: PARSER_VERSIONS,
    pendingHints: reportedSources,
  });
  for (const adapterKey of priorityOrder) {
    const policy = enrolment[adapterKey];
    if (policy.mode === "off" || sourceEnabled?.(adapterKey) === false) {
      continue;
    }
    const wave = replayWaveAdmission(policy, PARSER_VERSIONS[adapterKey]);
    if (wave.status === "held") {
      logger.info("case_law_replay.wave_held", {
        adapterKey,
        reason: wave.reason,
      });
      continue;
    }
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
                adapterKey: candidate.adapterKey,
                currentParserVersion: candidate.currentParserVersion,
                mode: candidate.mode,
              })
            ).length > 0,
        );
      }
      if (!probe) {
        await markFullReplayCompleted(context, candidate);
        return null;
      }
      onLag?.(candidate);
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

type HintDecisionQueryOptions =
  | { type: "source-priority"; source: BackgroundReplaySource; now: Date }
  | { type: "unreserved-row"; source: BackgroundReplaySource };

const hintDecisionQuery = (
  tx: Transaction,
  options: HintDecisionQueryOptions,
) => {
  const { source } = options;
  const duePending = (() => {
    switch (options.type) {
      case "unreserved-row":
        return undefined;
      case "source-priority":
        return source.mode === "enrolled"
          ? sql`EXISTS (${tx
              .select({ present: sql`1` })
              .from(caseLawReplayBatches)
              .where(
                and(
                  dueCaseLawReplayPendingReceipt(options.now),
                  eq(
                    caseLawReplayBatches.sourceId,
                    caseLawReplayReportedDecisions.sourceId,
                  ),
                  eq(caseLawReplayBatches.firstDecisionId, caseLawDecisions.id),
                  eq(
                    caseLawReplayBatches.sourceRawS3Key,
                    caseLawDecisions.sourceRawS3Key,
                  ),
                  eq(
                    caseLawReplayBatches.parserVersionTo,
                    source.currentParserVersion,
                  ),
                  lte(
                    caseLawReplayReportedDecisions.targetParserVersion,
                    caseLawReplayBatches.parserVersionTo,
                  ),
                  or(
                    isNull(caseLawDecisions.parserVersion),
                    lte(
                      caseLawDecisions.parserVersion,
                      source.currentParserVersion,
                    ),
                    parsedReplayInputPredicate(source.currentParserVersion),
                  ),
                ),
              )
              .limit(1)})`
          : undefined;
      default:
        options satisfies never;
        return panic("Unknown replay hint query purpose");
    }
  })();
  return tx
    .select({
      id: caseLawDecisions.id,
      sourceId: caseLawReplayReportedDecisions.sourceId,
      tier: caseLawReplayReportedDecisions.tier,
    })
    .from(caseLawReplayReportedDecisions)
    .innerJoin(
      caseLawDecisions,
      and(
        eq(caseLawDecisions.id, caseLawReplayReportedDecisions.decisionId),
        eq(caseLawDecisions.sourceId, caseLawReplayReportedDecisions.sourceId),
      ),
    )
    .where(
      and(
        eq(caseLawReplayReportedDecisions.sourceId, source.id),
        lte(
          caseLawReplayReportedDecisions.targetParserVersion,
          source.currentParserVersion,
        ),
        isNull(caseLawReplayReportedDecisions.completedAt),
        source.mode === "dry-run"
          ? isNull(caseLawReplayReportedDecisions.previewedAt)
          : undefined,
        isNull(caseLawDecisions.redactedAt),
        isNotNull(caseLawDecisions.sourceRawS3Key),
        or(
          replaySelectionPredicate(
            {
              type: "background",
              adapterKey: source.adapterKey,
              currentParserVersion: source.currentParserVersion,
              mode: source.mode,
            },
            tx,
          ),
          duePending,
        ),
      ),
    )
    .orderBy(
      sqlCaseFragment({
        operand: sql`${caseLawReplayReportedDecisions.tier}`,
        branches: REPLAY_HINT_TIERS.map(
          (tier) => sql`WHEN ${tier} THEN ${replayPriorityRank(tier)}`,
        ),
        fallback: sql`NULL::integer`,
      }),
      asc(caseLawReplayReportedDecisions.queuedAt),
      asc(caseLawReplayReportedDecisions.decisionId),
    )
    .limit(1);
};

const selectHintDecision = async (
  tx: Transaction,
  source: BackgroundReplaySource,
) => (await hintDecisionQuery(tx, { type: "unreserved-row", source })).at(0);

const selectNext = async (
  tx: Transaction,
  { source, after }: SelectNextOptions,
) => {
  const scopedDb = async <T>(work: (tx: Transaction) => Promise<T>) =>
    await work(tx);
  const selection = {
    type: "background",
    adapterKey: source.adapterKey,
    currentParserVersion: source.currentParserVersion,
    mode: source.mode,
  } as const;
  const reported = await selectHintDecision(tx, source);
  if (reported !== undefined) {
    return (
      (
        await selectReplayPage({
          scopedDb,
          sourceId: source.id,
          scope: { type: "decision", decisionId: reported.id },
          selection,
          after: null,
          until: reported.id,
          limit: 1,
        })
      ).at(0) ?? null
    );
  }
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
    // Preview and apply serialize their source checkpoint here.
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
    const id = `${generationBatchId(source, row)}${BACKGROUND_REPLAY_PREVIEW_SUFFIX}`;
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
        sourceRawS3Key: row.sourceRawS3Key,
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
    await admitDailyRow(tx, { source, batchId: id, utcDay });
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
        sourceRawS3Key: row.sourceRawS3Key,
        claimReadmission: receipt?.readmissions ?? 0,
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
  const row = await lockCaseLawReplayPendingBatch({
    tx,
    sourceId: source.id,
    now: new Date(now),
    cursor,
  });
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
  const decision = await lockReplayDecisionInput(
    tx,
    reservationBatch(source, row),
  );
  if (
    row.parserVersionTo < source.currentParserVersion ||
    row.sourceRawS3Key === null ||
    decision === undefined ||
    decision.redactedAt !== null ||
    (decision.parserVersion !== null &&
      decision.parserVersion > row.parserVersionTo &&
      !decision.parsedInputCurrent) ||
    decision.sourceRawS3Key !== row.sourceRawS3Key
  ) {
    // Unknown or replaced inputs cannot borrow the current input's completion.
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
  await admitDailyRow(tx, { source, batchId: row.id, utcDay });
  let reserved = row;
  if (row.status === "retry-exhausted") {
    // The checkpoint lock serializes readmission and attempt accounting.
    const updated = (
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
        .where(eq(caseLawReplayBatches.id, row.id))
        .returning()
    ).at(0);
    if (updated === undefined) {
      panic("The locked replay reservation disappeared during readmission");
    }
    reserved = updated;
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
  return {
    type: "reserved",
    batch: reservationBatch(source, reserved),
  } as const;
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

type ReadmitReplayBatchOptions = {
  source: BackgroundReplaySource;
  previous: typeof caseLawReplayBatches.$inferSelect;
  utcDay: string;
  now: () => number;
};

// The caller retains checkpoint, reservation and input locks through readmission.
const readmitReplayBatch = async (
  tx: Transaction,
  { source, previous, utcDay, now }: ReadmitReplayBatchOptions,
) => {
  const id = previous.id;
  if (previous.readmissions >= BACKGROUND_REPLAY_LIMITS.maxRowReadmissions) {
    const transition = await transitionLifecycle({
      tx,
      spec: TRANSITIONS.caseLawReplayBatches,
      id,
      moves: {
        status: { from: ["completed", "superseded"], to: "retry-terminal" },
        attemptState: { from: [previous.attemptState], to: "idle" },
      },
      set: {
        outcome: REPLAY_ROW_OUTCOME.RETRYABLE,
        applied: 0,
        blocked: 0,
        failed: 1,
        failureCode: "writer-retryable",
        failureMessageClass: replayFailure("writer-retryable").messageClass,
        retryAt: null,
        completedAt: new Date(now()),
      },
      recordTransitionAuditEvent: async (auditTx) =>
        await recordReplayMaintenanceAuditEvent(auditTx, {
          sourceId: source.id,
          action: "receipt-failed",
          resourceId: id,
          details: {
            status: "retry-terminal",
            readmissions: previous.readmissions,
          },
          createdAt: new Date(now()),
        }),
    });
    switch (transition.type) {
      case "transitioned":
        break;
      case "stale":
        return panic(
          "The locked replay reservation changed before terminal readmission",
        );
      default:
        transition satisfies never;
        return panic("Unhandled replay batch transition");
    }
    return { type: "empty" } as const;
  }
  await admitDailyRow(tx, { source, batchId: id, utcDay });
  const readmissions = previous.readmissions + 1;
  const transition = await transitionLifecycle({
    tx,
    spec: TRANSITIONS.caseLawReplayBatches,
    id,
    moves: {
      status: { from: ["completed", "superseded"], to: "reserved" },
      attemptState: { from: [previous.attemptState], to: "idle" },
    },
    set: {
      outcome: null,
      readmissions,
      attempts: 0,
      systemicFailures: 0,
      systemicProgress: 0,
      applied: 0,
      blocked: 0,
      failed: 0,
      retryAt: null,
      completedAt: null,
    },
    recordTransitionAuditEvent: async (auditTx) =>
      await recordReplayMaintenanceAuditEvent(auditTx, {
        sourceId: source.id,
        action: "receipt-reserved",
        resourceId: id,
        details: { readmissions },
        createdAt: new Date(now()),
      }),
  });
  switch (transition.type) {
    case "transitioned":
      break;
    case "stale":
      return panic("The locked replay reservation changed before readmission");
    default:
      transition satisfies never;
      return panic("Unhandled replay batch transition");
  }
  return {
    type: "reserved",
    batch: {
      ...reservationBatch(source, previous),
      claimReadmission: readmissions,
    },
  } as const;
};

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
    const id = generationBatchId(source, row);
    const previous = await lockCaseLawReplayBatch({
      tx,
      id,
      predicate: undefined,
    });
    if (previous !== undefined) {
      const batch = reservationBatch(source, previous);
      const current = await lockReplayDecisionInput(tx, batch);
      if (
        !canReadmitReplayBatch(previous) ||
        previous.sourceRawS3Key !== row.sourceRawS3Key ||
        current === undefined ||
        current.sourceRawS3Key !== row.sourceRawS3Key ||
        !current.readmissionEligible
      ) {
        return { type: "empty" } as const;
      }
      return await readmitReplayBatch(tx, { source, previous, utcDay, now });
    }
    // deterministic maintenance reservation and daily attempt accounting
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
          sourceRawS3Key: row.sourceRawS3Key,
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
    const current = await lockReplayDecisionInput(
      tx,
      reservationBatch(source, reserved),
    );
    if (
      current === undefined ||
      current.redactedAt !== null ||
      current.sourceRawS3Key !== reserved.sourceRawS3Key
    ) {
      await tx
        .update(caseLawReplayBatches)
        .set({
          status: "superseded",
          completedAt: new Date(now()),
        })
        .where(eq(caseLawReplayBatches.id, id));
      await recordReplayMaintenanceAuditEvent(tx, {
        sourceId: source.id,
        action: "receipt-superseded",
        resourceId: id,
        details: { parserVersion: source.currentParserVersion },
        createdAt: new Date(now()),
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
    await admitDailyRow(tx, { source, batchId: id, utcDay });
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
    const receipt = await lockCaseLawReplayBatch({
      tx,
      id: batch.id,
      predicate: replayReservationPredicate(batch),
    });
    if (receipt === undefined) {
      return "waiting";
    }
    if (
      receipt.status !== "reserved" ||
      (receipt.retryAt !== null && receipt.retryAt.getTime() > now())
    ) {
      return "waiting";
    }
    if (receipt.attempts >= BACKGROUND_REPLAY_LIMITS.maxRowAttempts) {
      const decision = await lockReplayDecisionInput(tx, batch);
      // Only this reservation's completely parsed input can recover a write.
      if (
        decision?.redactedAt === null &&
        batch.sourceRawS3Key !== null &&
        decision.sourceRawS3Key === batch.sourceRawS3Key &&
        decision.parsedInputCurrent &&
        decision.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED
      ) {
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
        .where(replayReservationPredicate(batch));

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
      .where(replayReservationPredicate(batch));
    return "ready";
  });

type CompleteBatchOptions = {
  batch: BackgroundReplayBatch;
  report: ReplayRowReport;
  durationMs: number;
  verdict: Verdict;
  healthyEvidence?: "adjacent-row" | "none";
};

type ReplayBlockedReceipt = typeof caseLawReplayBlocked.$inferInsert;

/** Writes the generation-specific terminal receipt inside its caller's transaction. */
const recordReplayBlockedReceipt = async (
  tx: Pick<Transaction, "insert" | "update">,
  receipt: ReplayBlockedReceipt,
) => {
  if (receipt.sourceRawS3Key === null || receipt.sourceRawS3Key === undefined) {
    return;
  }
  await tx
    .insert(caseLawReplayBlocked)
    .values(receipt)
    .onConflictDoUpdate({
      target: [
        caseLawReplayBlocked.decisionId,
        caseLawReplayBlocked.parserVersionTo,
      ],
      set: {
        sourceRawS3Key: receipt.sourceRawS3Key,
        parserVersionFrom: receipt.parserVersionFrom,
        outcome: receipt.outcome,
        reason: receipt.reason,
        detail: receipt.detail,
      },
    });
  await tx
    .update(caseLawReplayReportedDecisions)
    .set({ completedAt: sql`now()` })
    .where(
      and(
        eq(caseLawReplayReportedDecisions.sourceId, receipt.sourceId),
        eq(caseLawReplayReportedDecisions.decisionId, receipt.decisionId),
        lte(
          caseLawReplayReportedDecisions.targetParserVersion,
          receipt.parserVersionTo,
        ),
        isNull(caseLawReplayReportedDecisions.completedAt),
      ),
    );
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
  replayedSourceRawS3Key?: string;
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
    const receipt = await lockCaseLawReplayBatch({
      tx,
      id: batch.id,
      predicate: replayReservationPredicate(batch),
    });
    if (receipt === undefined) {
      return "retryable";
    }
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
    const decision = await lockReplayDecisionInput(tx, batch);
    if (
      decision?.redactedAt === null &&
      batch.sourceRawS3Key !== null &&
      decision.sourceRawS3Key === batch.sourceRawS3Key &&
      decision.parsedInputCurrent &&
      decision.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
      (failure.replayedSourceRawS3Key === undefined ||
        failure.replayedSourceRawS3Key === batch.sourceRawS3Key)
    ) {
      // A failed receipt write can follow a successful canonical decision write.
      // The database stamp wins over retry exhaustion, including the last attempt.
      const transition = await transitionLifecycle({
        tx,
        spec: TRANSITIONS.caseLawReplayBatches,
        id: batch.id,
        moves: {
          status: { from: ["reserved"], to: "completed" },
          attemptState: { from: [receipt.attemptState], to: "idle" },
        },
        set: {
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
        },
        recordTransitionAuditEvent: async (auditTx) =>
          await recordReplayMaintenanceAuditEvent(auditTx, {
            sourceId: batch.source.id,
            action: "receipt-applied",
            resourceId: batch.id,
            details: {
              attempts,
              status: "completed",
              failureCode: failure.code,
            },
            createdAt: new Date(now()),
          }),
      });
      switch (transition.type) {
        case "transitioned":
          break;
        case "stale":
          return panic("The locked replay reservation changed before recovery");
        default:
          transition satisfies never;
          return panic("Unhandled replay batch transition");
      }
      await recordReplayBlockedReceipt(tx, {
        sourceId: batch.source.id,
        decisionId: batch.decisionId,
        sourceRawS3Key: batch.sourceRawS3Key,
        parserVersionFrom: batch.parserVersionFrom,
        parserVersionTo: batch.targetParserVersion,
        outcome: "changed",
        reason: null,
      });
      await recordVerifiedProgress(tx, {
        sourceId: batch.source.id,
        completedAt: new Date(now()),
      });
      // a verified completion precedes cursor advancement atomically
      await tx
        .update(databaseBackfillStates)
        .set({ cursor: batch.decisionId, updatedAt: new Date(now()) })
        .where(eq(databaseBackfillStates.name, checkpointName(batch.source)));
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
      .where(replayReservationPredicate(batch));
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
  decision: Awaited<ReturnType<typeof lockReplayDecisionInput>>;
};
const checkReplayCompletion = ({
  batch,
  report,
  decision,
}: CheckReplayCompletionOptions): CheckedReplayCompletion => {
  if (decision === undefined || decision.redactedAt !== null) {
    return { type: "blocked" };
  }
  if (
    batch.sourceRawS3Key === null ||
    decision.sourceRawS3Key !== batch.sourceRawS3Key ||
    report.replayedSourceRawS3Key !== batch.sourceRawS3Key
  ) {
    return { type: "retryable" };
  }
  const moved = decision.parsedInputCurrent;
  const receipt = replayRowResult(report, batch.targetParserVersion);
  if (receipt === null) {
    return { type: "retryable" };
  }
  // A success requires the complete parsed-input proof, including equal output.
  if (receipt.outcome !== "rejected" && !moved) {
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

type CompleteReplayReceiptOptions = CheckReplayCompletionOptions & {
  recordReceipt: (receipt: ReplayBlockedReceipt) => Promise<void>;
};

/** Checks and records one terminal receipt against the raw generation replayed. */
export const completeReplayReceipt = async ({
  recordReceipt,
  batch,
  report,
  decision,
}: CompleteReplayReceiptOptions): Promise<CheckedReplayCompletion> => {
  const completion = checkReplayCompletion({ batch, report, decision });
  const terminal = completion.type === "terminal" ? completion.receipt : null;
  if (terminal === null) {
    return completion;
  }
  const reason = terminal.outcome === "rejected" ? terminal.reason : null;
  await recordReceipt({
    sourceId: batch.source.id,
    decisionId: terminal.decisionId,
    sourceRawS3Key: report.replayedSourceRawS3Key ?? null,
    parserVersionFrom: batch.parserVersionFrom,
    parserVersionTo: terminal.targetParserVersion,
    outcome: terminal.outcome,
    reason,
    detail: reason,
  });
  return completion;
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
    const receipt = await lockCaseLawReplayBatch({
      tx,
      id: batch.id,
      predicate: replayReservationPredicate(batch),
    });
    if (receipt === undefined) {
      return "retryable-completion";
    }
    if (receipt.status !== "reserved") {
      if (receipt.outcome === REPLAY_ROW_OUTCOME.UNCHANGED) {
        return "unchanged";
      }
      return receipt.applied > 0 ? "applied" : "blocked";
    }
    const decision = await lockReplayDecisionInput(tx, batch);
    const completion = await completeReplayReceipt({
      recordReceipt: async (blocked) =>
        await recordReplayBlockedReceipt(tx, blocked),
      batch,
      report,
      decision,
    });
    if (completion.type === "retryable") {
      return "retryable-completion";
    }
    const terminal = completion.type === "terminal" ? completion.receipt : null;
    const rowDisposition = completionDisposition(terminal);
    const successful = rowDisposition !== "blocked";
    // Both changed and equal-output parses require the current-input stamp.
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
      .where(replayReservationPredicate(batch));
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
    await tx
      .update(caseLawReplayReportedDecisions)
      .set({ previewedAt: new Date(now()) })
      .where(
        and(
          eq(caseLawReplayReportedDecisions.sourceId, batch.source.id),
          eq(caseLawReplayReportedDecisions.decisionId, batch.decisionId),
          lte(
            caseLawReplayReportedDecisions.targetParserVersion,
            batch.targetParserVersion,
          ),
          isNull(caseLawReplayReportedDecisions.completedAt),
        ),
      );
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
    await tx
      .update(caseLawReplaySourceProgress)
      .set({
        dryRunParserVersion: source.currentParserVersion,
        dryRunDiffSamples: [],
      })
      .where(
        and(
          eq(caseLawReplaySourceProgress.sourceId, source.id),
          or(
            isNull(caseLawReplaySourceProgress.dryRunParserVersion),
            lte(
              caseLawReplaySourceProgress.dryRunParserVersion,
              source.currentParserVersion,
            ),
          ),
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

const compactReplayHints = async (tx: Transaction, limit: number) => {
  const quotaPage = await buildCaseLawReplayVisitedQuotaCompactionQuery(tx, {
    cutoff: sql`clock_timestamp() - (${VISITED_REPLAY_ADMISSION_LIMITS.minuteMs * 2}::bigint * interval '1 millisecond')`,
    limit,
  });
  const hintPage = await buildCaseLawReplayHintCompactionQuery(tx, {
    cutoff: sql`clock_timestamp() - (${BACKGROUND_REPLAY_LIMITS.receiptRetentionDays}::integer * interval '1 day')`,
    limit,
  });
  if (quotaPage.length > 0) {
    await tx.delete(caseLawReplayVisitedQuotas).where(
      inArray(
        caseLawReplayVisitedQuotas.sourceId,
        quotaPage.map(({ sourceId }) => sourceId),
      ),
    );
  }
  if (hintPage.length > 0) {
    await tx
      .delete(caseLawReplayReportedDecisions)
      .where(
        or(
          ...hintPage.map(({ sourceId, decisionId, targetParserVersion }) =>
            and(
              eq(caseLawReplayReportedDecisions.sourceId, sourceId),
              eq(caseLawReplayReportedDecisions.decisionId, decisionId),
              eq(
                caseLawReplayReportedDecisions.targetParserVersion,
                targetParserVersion,
              ),
            ),
          ),
        ),
      );
  }
  return { compactedHints: hintPage.length, compactedQuotas: quotaPage.length };
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
    const hintCompaction = await compactReplayHints(tx, limit);
    const stale = buildReplayRetirementQuery(tx, limit);
    // Discover older terminal generations independently of new reservations.
    await tx
      .update(caseLawReplayBatches)
      .set({
        supersededAt: sql`coalesce(${caseLawReplayBatches.completedAt}, now())`,
      })
      .where(inArray(caseLawReplayBatches.id, stale));
    const old = await buildCaseLawReplayCompactionQuery(tx, {
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
    if (
      old.length === 0 &&
      auditPage.length === 0 &&
      hintCompaction.compactedHints === 0 &&
      hintCompaction.compactedQuotas === 0
    ) {
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
          ...hintCompaction,
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
    // Compact bounded batch history, never the current decision/parser receipt.
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
        ...hintCompaction,
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

const MAX_DRY_RUN_DIFF_SAMPLES = 20;
const dryRunDiffSamples = async (
  tx: Transaction,
  source: BackgroundReplaySource,
) => {
  const progress = (
    await tx
      .select({
        parserVersion: caseLawReplaySourceProgress.dryRunParserVersion,
        samples: caseLawReplaySourceProgress.dryRunDiffSamples,
      })
      .from(caseLawReplaySourceProgress)
      .where(eq(caseLawReplaySourceProgress.sourceId, source.id))
      .limit(1)
  ).at(0);
  if (
    progress?.parserVersion !== undefined &&
    progress.parserVersion !== null &&
    progress.parserVersion > source.currentParserVersion
  ) {
    return { type: "superseded" } as const;
  }
  return {
    type: "current",
    samples:
      progress?.parserVersion === source.currentParserVersion
        ? progress.samples
        : [],
  } as const;
};

type NeedsDryRunDiffSampleOptions = {
  source: BackgroundReplaySource;
  decisionId: BackgroundReplayBatch["decisionId"];
};
const needsDryRunDiffSample = async (
  { db }: ReplayStoreContext,
  { source, decisionId }: NeedsDryRunDiffSampleOptions,
) => {
  if (source.mode !== "dry-run") {
    panic("Only dry-run replay can sample derived diffs");
  }
  return await withReplayTransaction(db, async (tx) => {
    const manifest = await dryRunDiffSamples(tx, source);
    if (manifest.type === "superseded") {
      return false;
    }
    const { samples } = manifest;
    return (
      !samples.some((sample) => sample.decisionId === decisionId) &&
      samples.length < MAX_DRY_RUN_DIFF_SAMPLES
    );
  });
};

type RecordDryRunDiffSampleOptions = {
  source: BackgroundReplaySource;
  sample: ReplayDryRunDiffSample;
};
const recordDryRunDiffSample = async (
  { db }: ReplayStoreContext,
  { source, sample }: RecordDryRunDiffSampleOptions,
) => {
  if (source.mode !== "dry-run") {
    panic("Only dry-run replay can sample derived diffs");
  }
  await withReplayTransaction(db, async (tx) => {
    await lockCheckpoint(tx, source);
    const manifest = await dryRunDiffSamples(tx, source);
    if (manifest.type === "superseded") {
      return;
    }
    const { samples } = manifest;
    const previous = samples.findIndex(
      (existing) => existing.decisionId === sample.decisionId,
    );
    if (previous !== -1) {
      return;
    } else if (samples.length < MAX_DRY_RUN_DIFF_SAMPLES) {
      samples.push(sample);
    } else {
      return;
    }
    await tx
      .insert(caseLawReplaySourceProgress)
      .values({
        sourceId: source.id,
        dryRunParserVersion: source.currentParserVersion,
        dryRunDiffSamples: samples,
      })
      .onConflictDoUpdate({
        target: caseLawReplaySourceProgress.sourceId,
        set: {
          dryRunParserVersion: source.currentParserVersion,
          dryRunDiffSamples: samples,
        },
      });
  });
};

type EnqueueReportedDecisionOptions = {
  sourceId: BackgroundReplaySource["id"];
  decisionId: BackgroundReplayBatch["decisionId"];
  targetParserVersion: number;
};

const enqueueReportedDecision = async (
  { db, now }: ReplayStoreContext,
  { sourceId, decisionId, targetParserVersion }: EnqueueReportedDecisionOptions,
) =>
  await withReplayTransaction(db, async (tx) => {
    await lockCaseLawDecisionRows({ tx, decisionIds: [decisionId] });
    const decision = (
      await tx
        .select({
          id: caseLawDecisions.id,
          adapterKey: caseLawSources.adapterKey,
          parsedInputCurrent: parsedReplayInputPredicate(targetParserVersion),
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            eq(caseLawDecisions.id, decisionId),
            eq(caseLawDecisions.sourceId, sourceId),
            isNull(caseLawDecisions.redactedAt),
            isNotNull(caseLawDecisions.sourceRawS3Key),
          ),
        )
        .limit(1)
    ).at(0);
    if (decision === undefined) {
      return { type: "unavailable" } as const;
    }
    const adapterKey = Object.values(ADAPTER_KEYS).find(
      (key) => key === decision.adapterKey,
    );
    if (
      adapterKey === undefined ||
      targetParserVersion !== PARSER_VERSIONS[adapterKey]
    ) {
      return { type: "parser-mismatch" } as const;
    }
    // An already proved parse needs no CPU work. A later parser bump has a new queue identity.
    const completedAt = decision.parsedInputCurrent ? new Date(now()) : null;
    await tx
      .insert(caseLawReplayReportedDecisions)
      .values({
        sourceId,
        decisionId,
        targetParserVersion,
        queuedAt: new Date(now()),
        tier: REPLAY_PRIORITY.REPORTED,
        completedAt,
      })
      .onConflictDoUpdate({
        target: [
          caseLawReplayReportedDecisions.sourceId,
          caseLawReplayReportedDecisions.decisionId,
          caseLawReplayReportedDecisions.targetParserVersion,
        ],
        set: { tier: REPLAY_PRIORITY.REPORTED, completedAt },
      });
    await recordReplayMaintenanceAuditEvent(tx, {
      sourceId,
      action: "reported-decision-queued",
      resourceId: decisionId,
      details: { parserVersion: targetParserVersion },
      createdAt: new Date(now()),
    });
    return { type: completedAt === null ? "queued" : "current" } as const;
  });

type EnqueueVisitedDecisionsOptions = {
  sourceId: BackgroundReplaySource["id"];
  decisionIds: readonly BackgroundReplayBatch["decisionId"][];
};

const lockVisitedAdmission = async (
  tx: Transaction,
  sourceId: BackgroundReplaySource["id"],
) => {
  await tx
    .insert(caseLawReplayVisitedQuotas)
    .values({
      sourceId,
      windowStartedAt: sql`date_trunc('minute', clock_timestamp())`,
    })
    .onConflictDoUpdate({
      target: caseLawReplayVisitedQuotas.sourceId,
      set: { sourceId },
    });
  const locked = await lockCaseLawReplayVisitedQuota(tx, sourceId);
  if (locked === undefined) {
    panic("Visited replay quota disappeared before admission");
  }
  // Read the database clock after acquiring the fleet lock, never before a lock wait.
  const admittedAt =
    (
      await tx.execute<{ minute: string }>(
        sql`SELECT clock_timestamp()::text AS minute`,
      )
    ).at(0)?.minute ??
    panic("Database clock did not return a visited replay admission minute");
  const quota = (
    await tx
      .update(caseLawReplayVisitedQuotas)
      .set({
        windowStartedAt: sql`date_trunc('minute', ${admittedAt}::timestamptz)`,
        admittedRows: sql`CASE WHEN ${caseLawReplayVisitedQuotas.windowStartedAt} = date_trunc('minute', ${admittedAt}::timestamptz) THEN ${caseLawReplayVisitedQuotas.admittedRows} ELSE 0 END`,
      })
      .where(eq(caseLawReplayVisitedQuotas.sourceId, sourceId))
      .returning({ admittedRows: caseLawReplayVisitedQuotas.admittedRows })
  ).at(0);
  return {
    remaining:
      VISITED_REPLAY_ADMISSION_LIMITS.rowsPerSourceMinute -
      (quota?.admittedRows ?? panic("Locked visited replay quota disappeared")),
    admittedAt,
  };
};

const enqueueVisitedDecisions = async (
  { db, now, sourceEnabled }: ReplayStoreContext,
  { sourceId, decisionIds }: EnqueueVisitedDecisionsOptions,
) => {
  if (decisionIds.length > VISITED_REPLAY_ADMISSION_LIMITS.batchRows) {
    panic("Visited replay admission exceeds the bounded hint batch");
  }
  const ids = [...new Set(decisionIds)];
  if (ids.length === 0) {
    return { type: "queued", inserted: 0, deferred: 0 } as const;
  }
  return await withReplayTransaction(db, async (tx) => {
    const source = (
      await tx
        .select({ adapterKey: caseLawSources.adapterKey })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
    ).at(0);
    const adapterKey = Object.values(ADAPTER_KEYS).find(
      (key) => key === source?.adapterKey,
    );
    if (adapterKey === undefined || sourceEnabled?.(adapterKey) === false) {
      return { type: "unavailable" } as const;
    }
    const targetParserVersion = PARSER_VERSIONS[adapterKey];
    const { remaining, admittedAt } = await lockVisitedAdmission(tx, sourceId);
    if (remaining === 0) {
      return { type: "queued", inserted: 0, deferred: ids.length } as const;
    }
    const inserted = await tx
      .insert(caseLawReplayReportedDecisions)
      .select(
        tx
          .select({
            sourceId: caseLawDecisions.sourceId,
            decisionId: caseLawDecisions.id,
            targetParserVersion: sql`${targetParserVersion}::integer`.as(
              "target_parser_version",
            ),
            tier: sql`${REPLAY_PRIORITY.VISITED}::text`.as("tier"),
            queuedAt: sql`${admittedAt}::timestamptz`.as("queued_at"),
            previewedAt: sql`NULL::timestamptz`.as("previewed_at"),
            completedAt: sql`NULL::timestamptz`.as("completed_at"),
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              inArray(caseLawDecisions.id, ids),
              isNull(caseLawDecisions.redactedAt),
              isNotNull(caseLawDecisions.sourceRawS3Key),
              // The apply selector owns input-proof and receipt eligibility even before a wave enrols.
              replaySelectionPredicate(
                {
                  type: "background",
                  adapterKey,
                  currentParserVersion: targetParserVersion,
                  mode: "enrolled",
                },
                tx,
              ),
              sql`NOT EXISTS (${tx
                .select({ present: sql`1` })
                .from(caseLawReplayReportedDecisions)
                .where(
                  and(
                    eq(caseLawReplayReportedDecisions.sourceId, sourceId),
                    eq(
                      caseLawReplayReportedDecisions.decisionId,
                      caseLawDecisions.id,
                    ),
                    eq(
                      caseLawReplayReportedDecisions.targetParserVersion,
                      targetParserVersion,
                    ),
                  ),
                )
                .limit(1)})`,
            ),
          )
          .orderBy(asc(caseLawDecisions.id))
          .limit(remaining),
      )
      .onConflictDoNothing()
      .returning({ decisionId: caseLawReplayReportedDecisions.decisionId });
    // Only newly inserted rows spend quota. A duplicate or concurrent operator elevation spends none.
    if (inserted.length > 0) {
      await tx
        .update(caseLawReplayVisitedQuotas)
        .set({
          admittedRows: sql`${caseLawReplayVisitedQuotas.admittedRows} + ${inserted.length}`,
        })
        .where(eq(caseLawReplayVisitedQuotas.sourceId, sourceId));
      await recordReplayMaintenanceAuditEvent(tx, {
        sourceId,
        action: "visited-decisions-queued",
        resourceId: sourceId,
        details: {
          parserVersion: targetParserVersion,
          queuedRows: inserted.length,
        },
        createdAt: new Date(now()),
      });
    }
    return {
      type: "queued",
      inserted: inserted.length,
      deferred: ids.length - inserted.length,
    } as const;
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
    beforeComplete,
    gate,
    onHeld,
  };
  return {
    needsDryRunDiffSample: async (
      source: BackgroundReplaySource,
      decisionId: BackgroundReplayBatch["decisionId"],
    ) => await needsDryRunDiffSample(context, { source, decisionId }),
    recordDryRunDiffSample: async (
      source: BackgroundReplaySource,
      sample: ReplayDryRunDiffSample,
    ) => await recordDryRunDiffSample(context, { source, sample }),
    enqueueVisitedDecisions: async (options: EnqueueVisitedDecisionsOptions) =>
      await enqueueVisitedDecisions(context, options),
    enqueueReportedDecision: async (options: EnqueueReportedDecisionOptions) =>
      await enqueueReportedDecision(context, options),
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
