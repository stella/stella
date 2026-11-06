import { panic, Result } from "better-result";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import * as v from "valibot";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";
import { DAY_IN_MS, Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { setSharedTransactionTimeouts } from "@/api/db/shared-pool-timeouts";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { unreadPublisherError } from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import {
  parsePublisherRetryAfter,
  PublisherRateLimitRefusalError,
} from "@/api/handlers/case-law/ingestion/adapters/retry";
import { probeUkFclRemoval } from "@/api/handlers/case-law/ingestion/adapters/uk-fcl-removal";
import { removePublisherDecision } from "@/api/handlers/case-law/publisher-removal";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawRemovalSource } from "@/api/lib/db/aggregate-lock";
import type {
  AbsenceEvidence,
  ReadOutcome,
  ReadRefusalScope,
} from "@/api/lib/errors/read-outcome";
import {
  AdapterFetchError,
  DatabaseError,
} from "@/api/lib/errors/tagged-errors";
import {
  REMOVAL_SUPERSEDED_REASON,
  supersededRemovalEvidence,
} from "@/api/lib/legal-search/removal-evidence";
import {
  REMOVAL_PENDING_REASON,
  REMOVAL_UNPROBEABLE_REASON,
  removalCheckpointSchema,
} from "@/api/lib/legal-search/removal-reconciliation-state";
import type {
  RemovalCheckpoint,
  RemovalStepOutcome,
  UnprobeableRemovalRead,
} from "@/api/lib/legal-search/removal-reconciliation-state";
import {
  nextRemovalRetryAt,
  persistRemovalOutcomeTx,
  selectDueRemovalRetries,
} from "@/api/lib/legal-search/removal-reconciliation-store";
import type { RemovalRetryItem } from "@/api/lib/legal-search/removal-reconciliation-store";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

export const REMOVAL_RECONCILIATION_CONFIG_KEY = "removalReconciliation";
export const REMOVAL_SWEEP_INTERVAL_MS = 7 * DAY_IN_MS;
const REMOVAL_SWEEP_REQUEST_BUDGET = 100;
export const REMOVAL_SWEEP_TIME_BUDGET_MS = 60_000;
export const REMOVAL_RETRY_PER_KIND_BUDGET = 10;
const REMOVAL_RETRY_TIME_BUDGET_MS = 30_000;
const SOURCE_REFUSAL_MIN_HOLD_MS = 3_600_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export type PublisherRemovalRead =
  | Exclude<ReadOutcome<null>, { type: "absent" }>
  | {
      readonly type: "absent";
      readonly evidence: Exclude<AbsenceEvidence, "stated-zero">;
    }
  | UnprobeableRemovalRead;
type RemovalProbe = (
  identity: string,
  signal: AbortSignal,
) => Promise<Result<PublisherRemovalRead, AdapterFetchError>>;
const REMOVAL_SOURCE_PROBES = {
  [ADAPTER_KEYS.UK_FCL]: probeUkFclRemoval,
} as const satisfies Record<string, RemovalProbe>;

type SweepOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  signal: AbortSignal;
  now?: () => Date;
  clock?: () => number;
  probe?: RemovalProbe;
  remove?: typeof removePublisherDecision;
};
type SourcePausedOutcome = { type: "source-paused"; resumeAt: string };
type DiscoveryOutcome =
  | { type: "paused"; checked: number; resumeAt: Date }
  | {
      type: "disabled" | "not-due" | "complete" | "budget" | "contended";
      checked: number;
    };
type SweepOutcome = DiscoveryOutcome & {
  retried: number;
  nextRetryAt: Date | null;
};
type RemovalSource = NonNullable<Awaited<ReturnType<typeof readSource>>>;
type StepOrigin =
  { type: "discovery" } | { type: "retry"; item: RemovalRetryItem };
type RemovalItemOutcome = {
  decisionId: SafeId<"caseLawDecision">;
  outcome: RemovalStepOutcome;
  origin: StepOrigin;
};

const readRemovalControl = (value: unknown) => {
  if (value === undefined) {
    return "disabled";
  }
  const parsed = v.safeParse(
    v.strictObject({ status: v.picklist(["enabled", "disabled"]) }),
    value,
  );
  return parsed.success
    ? parsed.output.status
    : panic("Invalid publisher removal control");
};
const readSource = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
) =>
  await scopedDb(async (tx) =>
    (
      await tx
        .select({
          config: caseLawSources.config,
          adapterKey: caseLawSources.adapterKey,
          removalCheckpoint: caseLawSources.removalCheckpoint,
        })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
    ).at(0),
  );
const readerForSource = (
  source: RemovalSource,
  probe: RemovalProbe | undefined,
) =>
  readRemovalControl(source.config?.[REMOVAL_RECONCILIATION_CONFIG_KEY]) ===
  "disabled"
    ? undefined
    : (probe ??
      Object.entries(REMOVAL_SOURCE_PROBES).find(
        ([key]) => key === source.adapterKey,
      )?.[1]);

const expectedSource = (
  sourceId: SafeId<"caseLawSource">,
  source: RemovalSource,
) =>
  and(
    eq(caseLawSources.id, sourceId),
    eq(caseLawSources.config, source.config ?? {}),
    source.removalCheckpoint === null
      ? isNull(caseLawSources.removalCheckpoint)
      : eq(caseLawSources.removalCheckpoint, source.removalCheckpoint),
  );

type CommitRemovalProgressOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  source: RemovalSource;
  next: RemovalCheckpoint | null;
  items: readonly [] | readonly [RemovalItemOutcome];
  now: Date;
};
/** The outcome record and cursor commit together, after the source CAS is locked. */
const commitRemovalProgress = async ({
  scopedDb,
  sourceId,
  source,
  next,
  items,
  now,
}: CommitRemovalProgressOptions) => {
  let accepted = false;
  return await commitReplaySafeIngestionBatch({
    runInTransaction: scopedDb,
    checkpoint: next,
    items,
    persistItems: async (tx, entries) => {
      await lockCaseLawRemovalSource({ tx, sourceId });
      const held = (
        await tx
          .select({ id: caseLawSources.id })
          .from(caseLawSources)
          .where(expectedSource(sourceId, source))
          .limit(1)
      ).at(0);
      if (held === undefined) {
        return false;
      }
      for (const entry of entries) {
        // db-await-in-loop: a source step commits its fixed, bounded disposition set.
        if (!(await persistRemovalOutcomeTx(tx, { sourceId, ...entry, now }))) {
          return false;
        }
      }
      accepted = true;
      return true;
    },
    persistCheckpoint: async (tx, checkpoint) => {
      if (!accepted) {
        return;
      }
      // audit: skip — checkpoint and typed reconciliation records form one durable source step.
      const updated = await tx
        .update(caseLawSources)
        .set({ removalCheckpoint: checkpoint })
        .where(expectedSource(sourceId, source))
        .returning({ id: caseLawSources.id });
      if (updated.length !== 1) {
        panic("Locked removal checkpoint changed");
      }
    },
  });
};

type InitialCheckpointOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};
const initialRemovalCheckpoint = async ({
  scopedDb,
  sourceId,
  now,
}: InitialCheckpointOptions): Promise<RemovalCheckpoint> => {
  const last = await scopedDb(async (tx) =>
    (
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId))
        .orderBy(desc(caseLawDecisions.id))
        .limit(1)
    ).at(0),
  );
  return last === undefined
    ? {
        status: "waiting",
        nextCycleAt: new Date(
          now.getTime() + REMOVAL_SWEEP_INTERVAL_MS,
        ).toISOString(),
      }
    : { status: "running", cursor: null, ceiling: last.id };
};

const publisherRemovalPause = (
  error: unknown,
  now: Date,
): SourcePausedOutcome | null => {
  if (
    error instanceof AdapterFetchError &&
    error.stopKind === INGESTION_STOP_KIND.PUBLISHER_REFUSAL
  ) {
    const epochMs = now.getTime();
    const retryAfterMs =
      parsePublisherRetryAfter(error.retryAfter ?? null, epochMs) ?? 0;
    const sharedCooldown =
      error instanceof PublisherRateLimitRefusalError
        ? error.cooldownUntilEpochMs
        : epochMs;
    // Source refusals use at least an hourly hold and preserve longer publisher or gate deadlines.
    return {
      type: "source-paused",
      resumeAt: new Date(
        Math.min(
          MAX_DATE_EPOCH_MS,
          Math.max(
            epochMs + SOURCE_REFUSAL_MIN_HOLD_MS,
            epochMs + retryAfterMs,
            sharedCooldown,
          ),
        ),
      ).toISOString(),
    };
  }
  return null;
};

type RemovalObservation =
  | Exclude<PublisherRemovalRead, { type: "refused" }>
  | (Extract<PublisherRemovalRead, { type: "refused" }> & {
      scope: Exclude<ReadRefusalScope, "source">;
    });
const removalObservation = (
  outcome: PublisherRemovalRead,
): Result<RemovalObservation, AdapterFetchError> => {
  if (outcome.type !== "refused") {
    return Result.ok(outcome);
  }
  if (outcome.scope === "source") {
    return Result.err(
      unreadPublisherError({
        outcome,
        adapterKey: "publisher-removal",
        cursor: null,
        message: "Publisher removal source paused",
      }),
    );
  }
  return Result.ok({
    type: outcome.type,
    scope: outcome.scope,
    status: outcome.status,
    cause: outcome.cause,
  });
};

type ProcessRemovalDecisionOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  reader: RemovalProbe;
  remove: typeof removePublisherDecision;
  signal: AbortSignal;
  mode: { type: "discovery" } | { type: "retry"; item: RemovalRetryItem };
  now: () => Date;
};
/** Every item-local failure is an explicit durable disposition, never an enumeration stop. */
const processRemovalDecision = async ({
  scopedDb,
  sourceId,
  decisionId,
  reader,
  remove,
  signal,
  mode,
  now,
}: ProcessRemovalDecisionOptions): Promise<
  RemovalStepOutcome | SourcePausedOutcome
> => {
  let evidence =
    mode.type === "retry" &&
    mode.item.payload.type === "pending" &&
    mode.item.payload.operation === "erase"
      ? mode.item.payload.evidence
      : undefined;
  const result = await Result.tryPromise({
    try: async (): Promise<RemovalStepOutcome | SourcePausedOutcome> => {
      const decision = await scopedDb(async (tx) =>
        (
          await tx
            .select({
              id: caseLawDecisions.id,
              sourceId: caseLawDecisions.sourceId,
              sourceDocumentId: caseLawDecisions.sourceDocumentId,
              redactedAt: caseLawDecisions.redactedAt,
              sourceObservedAt: caseLawDecisions.sourceObservedAt,
              sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
            })
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.id, decisionId),
                eq(caseLawDecisions.sourceId, sourceId),
              ),
            )
            .limit(1)
        ).at(0),
      );
      if (decision === undefined) {
        return { type: "settled" };
      }
      if (evidence !== undefined) {
        const reason = supersededRemovalEvidence(evidence, decision);
        if (reason !== null) {
          return { type: "superseded", reason, evidence };
        }
      }
      const revision = {
        decisionId,
        sourceId,
        sourceObservationOrder:
          decision.sourceObservationOrder?.toString() ?? null,
        sourceObservedAt: decision.sourceObservedAt?.toISOString() ?? null,
      };
      const erasureRetry = evidence !== undefined;
      if (decision.redactedAt === null) {
        if (decision.sourceDocumentId === null) {
          return {
            type: "unprobeable",
            reason: REMOVAL_UNPROBEABLE_REASON.MISSING_IDENTITY,
          };
        }
        // A queued absence is rechecked before its first irreversible redaction.
        const observed = (
          await reader(decision.sourceDocumentId, signal)
        ).andThen(removalObservation);
        if (observed.isErr()) {
          const paused = publisherRemovalPause(observed.error, now());
          if (paused !== null) {
            return paused;
          }
          captureError(
            observed.error,
            handlerErrorContext("caseLaw.removal.probe_failed", { decisionId }),
          );
          return {
            type: "pending",
            operation: "probe",
            reason: REMOVAL_PENDING_REASON.OPERATION_FAILED,
          };
        }
        const observation = observed.value;
        switch (observation.type) {
          case "present":
            return evidence === undefined
              ? { type: "settled" }
              : {
                  type: "superseded",
                  evidence,
                  reason: REMOVAL_SUPERSEDED_REASON.RESTORED,
                };
          case "unprobeable":
            return observation;
          case "unavailable":
            return {
              type: "pending",
              operation: "probe",
              reason: REMOVAL_PENDING_REASON.PUBLISHER_UNAVAILABLE,
            };
          case "refused":
            return {
              type: "pending",
              operation: "probe",
              reason: REMOVAL_PENDING_REASON.PUBLISHER_REFUSED,
            };
          case "absent":
            evidence = {
              ...revision,
              type: "publisher-absence",
              sourceDocumentId: decision.sourceDocumentId,
              observedAt: now().toISOString(),
              absence: observation.evidence,
            };
            break;
          default:
            observation satisfies never;
            return panic("Unhandled removal observation");
        }
      } else {
        evidence ??= {
          ...revision,
          type: "existing-redaction",
          sourceDocumentId: decision.sourceDocumentId,
          observedAt: now().toISOString(),
        };
      }
      if (mode.type === "discovery" || !erasureRetry) {
        return {
          type: "pending",
          operation: "erase",
          evidence,
          reason:
            decision.redactedAt === null
              ? REMOVAL_PENDING_REASON.PUBLISHER_ABSENT
              : REMOVAL_PENDING_REASON.STORES_PENDING,
        };
      }
      const removed = await remove({ scopedDb, decisionId, evidence });
      if (removed.isErr()) {
        captureError(
          removed.error,
          handlerErrorContext("caseLaw.removal.operation_failed", {
            decisionId,
          }),
        );
        return {
          type: "pending",
          operation: "erase",
          evidence,
          reason: REMOVAL_PENDING_REASON.OPERATION_FAILED,
        };
      }
      switch (removed.value.type) {
        case "superseded":
          return { type: "superseded", reason: removed.value.reason, evidence };
        case "pending":
          return {
            type: "pending",
            operation: "erase",
            evidence,
            reason: REMOVAL_PENDING_REASON.STORES_PENDING,
          };
        case "removed":
          return { type: "settled" };
        default:
          removed.value satisfies never;
          return panic("Unhandled publisher removal outcome");
      }
    },
    catch: (cause) => cause,
  });
  if (result.isOk()) {
    return result.value;
  }
  const paused = publisherRemovalPause(result.error, now());
  if (paused !== null) {
    return paused;
  }
  captureError(
    result.error,
    handlerErrorContext("caseLaw.removal.operation_failed", { decisionId }),
  );
  return evidence !== undefined
    ? {
        type: "pending",
        operation: "erase",
        evidence,
        reason: REMOVAL_PENDING_REASON.OPERATION_FAILED,
      }
    : {
        type: "pending",
        operation: "probe",
        reason: REMOVAL_PENDING_REASON.OPERATION_FAILED,
      };
};

type DiscoveryOptions = Required<
  Pick<SweepOptions, "sourceId" | "signal" | "now" | "remove">
> & {
  probe: RemovalProbe | undefined;
  scopedDb: ScopedDb;
  deadline: number;
  clock: () => number;
};
const discoverPublisherRemovals = async ({
  scopedDb,
  sourceId,
  signal,
  now,
  probe,
  remove,
  deadline,
  clock,
}: DiscoveryOptions): Promise<DiscoveryOutcome> => {
  let checked = 0;
  while (checked < REMOVAL_SWEEP_REQUEST_BUDGET && clock() < deadline) {
    signal.throwIfAborted();
    // db-await-in-loop: source control and CAS state are read before each bounded discovery step.
    const source = await readSource(scopedDb, sourceId);
    if (source === undefined) {
      return { type: "disabled", checked };
    }
    const reader = readerForSource(source, probe);
    if (reader === undefined) {
      return { type: "disabled", checked };
    }
    const parsed = v.safeParse(
      v.nullable(removalCheckpointSchema),
      source.removalCheckpoint,
    );
    if (!parsed.success) {
      return panic("Invalid publisher removal checkpoint");
    }
    const state = parsed.output;
    const commit = async (
      next: RemovalCheckpoint | null,
      items: CommitRemovalProgressOptions["items"] = [],
    ) =>
      await commitRemovalProgress({
        scopedDb,
        sourceId,
        source,
        next,
        items,
        now: now(),
      });
    if (state?.status === "paused") {
      const resumeAt = new Date(state.resumeAt);
      if (resumeAt.getTime() > now().getTime()) {
        return { type: "paused", checked, resumeAt };
      }
      // db-await-in-loop: resume the exact saved discovery state after the durable publisher hold.
      if (!(await commit(state.resume))) {
        return { type: "contended", checked };
      }
      continue;
    }
    if (state === null) {
      // db-await-in-loop: initialization pins a finite source range before enumeration.
      const next = await initialRemovalCheckpoint({
        scopedDb,
        sourceId,
        now: now(),
      });
      // db-await-in-loop: initialize the cycle under the same source CAS.
      if (!(await commit(next))) {
        return { type: "contended", checked };
      }
      if (next.status === "waiting") {
        return { type: "complete", checked };
      }
      continue;
    }
    if (state.status === "waiting") {
      if (
        Temporal.Instant.from(state.nextCycleAt).epochMilliseconds >
        now().getTime()
      ) {
        return { type: "not-due", checked };
      }
      // db-await-in-loop: reset only an elapsed discovery cycle, preserving its retry lane.
      if (!(await commit(null))) {
        return { type: "contended", checked };
      }
      continue;
    }
    // db-await-in-loop: one indexed identity is selected per discovery step.
    const decision = await scopedDb(async (tx) =>
      (
        await tx
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              lte(
                caseLawDecisions.id,
                brandPersistedCaseLawDecisionId(state.ceiling),
              ),
              state.cursor === null
                ? undefined
                : gt(
                    caseLawDecisions.id,
                    brandPersistedCaseLawDecisionId(state.cursor),
                  ),
            ),
          )
          .orderBy(caseLawDecisions.id)
          .limit(1)
      ).at(0),
    );
    if (decision === undefined) {
      const committed = await commit({
        status: "waiting",
        nextCycleAt: new Date(
          now().getTime() + REMOVAL_SWEEP_INTERVAL_MS,
        ).toISOString(),
      });
      return { type: committed ? "complete" : "contended", checked };
    }
    // db-await-in-loop: every classified outcome flows through the single advancing commit below.
    const outcome = await processRemovalDecision({
      scopedDb,
      sourceId,
      decisionId: decision.id,
      reader,
      remove,
      signal,
      mode: { type: "discovery" },
      now,
    });
    const next = {
      status: "running",
      cursor: decision.id,
      ceiling: state.ceiling,
    } as const;
    const disposition =
      outcome.type === "source-paused"
        ? ({
            type: "pending",
            operation: "probe",
            reason: REMOVAL_PENDING_REASON.PUBLISHER_REFUSED,
          } as const)
        : outcome;
    // db-await-in-loop: ordered per-item CAS records the disposition and advances atomically.
    const committed = await commit(
      outcome.type === "source-paused"
        ? { status: "paused", resume: next, resumeAt: outcome.resumeAt }
        : next,
      [
        {
          decisionId: decision.id,
          outcome: disposition,
          origin: { type: "discovery" },
        },
      ],
    );
    if (!committed) {
      return { type: "contended", checked };
    }
    checked++;
    if (outcome.type === "source-paused") {
      return { type: "paused", checked, resumeAt: new Date(outcome.resumeAt) };
    }
  }
  return { type: "budget", checked };
};

type RetryOptions = DiscoveryOptions;
const retryPublisherRemovals = async ({
  scopedDb,
  sourceId,
  signal,
  now,
  probe,
  remove,
  deadline,
  clock,
}: RetryOptions): Promise<{ retried: number; pauseUntil: Date | null }> => {
  const items = await selectDueRemovalRetries({
    scopedDb,
    sourceId,
    now: now(),
    perKindLimit: REMOVAL_RETRY_PER_KIND_BUDGET,
  });
  let retried = 0;
  for (const item of items) {
    if (clock() >= deadline) {
      break;
    }
    signal.throwIfAborted();
    // db-await-in-loop: honor the current kill switch and source CAS before every retry.
    const source = await readSource(scopedDb, sourceId);
    if (source === undefined || source.removalCheckpoint?.status === "paused") {
      break;
    }
    const reader = readerForSource(source, probe);
    if (reader === undefined) {
      break;
    }
    // db-await-in-loop: each due item has one attempt, bounded by the lane's per-kind budget.
    const outcome = await processRemovalDecision({
      scopedDb,
      sourceId,
      decisionId: item.decisionId,
      reader,
      remove,
      signal,
      mode: { type: "retry", item },
      now,
    });
    const disposition =
      outcome.type === "source-paused"
        ? ({
            type: "pending",
            operation: "probe",
            reason: REMOVAL_PENDING_REASON.PUBLISHER_REFUSED,
          } as const)
        : outcome;
    // db-await-in-loop: ordered per-item CAS settles retries without rewinding discovery.
    const committed = await commitRemovalProgress({
      scopedDb,
      sourceId,
      source,
      next:
        outcome.type === "source-paused"
          ? {
              status: "paused",
              resume: source.removalCheckpoint,
              resumeAt: outcome.resumeAt,
            }
          : source.removalCheckpoint,
      items: [
        {
          decisionId: item.decisionId,
          outcome: disposition,
          origin: { type: "retry", item },
        },
      ],
      now: now(),
    });
    if (committed) {
      retried++;
      if (outcome.type === "source-paused") {
        return { retried, pauseUntil: new Date(outcome.resumeAt) };
      }
    } else {
      break;
    }
  }
  return { retried, pauseUntil: null };
};

/** An elapsed source hold resumes before the priority completion phase. */
const prepareRemovalRun = async ({
  scopedDb,
  sourceId,
  probe,
  now,
}: DiscoveryOptions): Promise<{ type: "ready" } | DiscoveryOutcome> => {
  const source = await readSource(scopedDb, sourceId);
  if (source === undefined || readerForSource(source, probe) === undefined) {
    return { type: "disabled", checked: 0 };
  }
  const state = v.parse(
    v.nullable(removalCheckpointSchema),
    source.removalCheckpoint,
  );
  if (state?.status !== "paused") {
    return { type: "ready" };
  }
  const resumeAt = new Date(state.resumeAt);
  if (resumeAt.getTime() > now().getTime()) {
    return { type: "paused", checked: 0, resumeAt };
  }
  const resumed = await commitRemovalProgress({
    scopedDb,
    sourceId,
    source,
    next: state.resume,
    items: [],
    now: now(),
  });
  return resumed ? { type: "ready" } : { type: "contended", checked: 0 };
};

/** Weekly discovery and bounded durable completion share source control, not a cursor. */
export const reconcilePublisherRemovals = async ({
  scopedDb: database,
  sourceId,
  signal,
  now = () => new Date(),
  clock = () => performance.now(),
  probe,
  remove = removePublisherDecision,
}: SweepOptions): Promise<Result<SweepOutcome, DatabaseError>> =>
  await Result.tryPromise({
    try: async () => {
      const wallDeadline = performance.now() + REMOVAL_SWEEP_TIME_BUDGET_MS;
      const deadline = clock() + REMOVAL_SWEEP_TIME_BUDGET_MS;
      const runSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(REMOVAL_SWEEP_TIME_BUDGET_MS),
      ]);
      const scopedDb: ScopedDb = async (run) =>
        await database(async (tx) => {
          runSignal.throwIfAborted();
          const remainingMs = Math.max(
            1,
            Math.ceil(wallDeadline - performance.now()),
          );
          await setSharedTransactionTimeouts(tx, {
            statementTimeoutMs: Math.min(30_000, remainingMs),
            lockTimeoutMs: Math.min(1000, remainingMs),
          });
          return await run(tx);
        });
      const context = {
        scopedDb,
        sourceId,
        signal: runSignal,
        now,
        probe,
        remove,
        deadline,
        clock,
      };
      const prepared = await prepareRemovalRun(context);
      if (prepared.type !== "ready") {
        return {
          ...prepared,
          retried: 0,
          nextRetryAt: prepared.type === "paused" ? prepared.resumeAt : null,
        };
      }
      // Due erasures have their own first phase; enumeration cannot spend its reservation.
      const first = await retryPublisherRemovals({
        ...context,
        deadline: Math.min(deadline, clock() + REMOVAL_RETRY_TIME_BUDGET_MS),
      });
      if (first.pauseUntil !== null) {
        return {
          type: "paused",
          checked: 0,
          retried: first.retried,
          resumeAt: first.pauseUntil,
          nextRetryAt: first.pauseUntil,
        };
      }
      const discovered = await discoverPublisherRemovals(context);
      if (discovered.type === "paused") {
        return {
          ...discovered,
          retried: first.retried,
          nextRetryAt: discovered.resumeAt,
        };
      }
      if (discovered.type === "disabled" || clock() >= deadline) {
        return {
          ...discovered,
          retried: first.retried,
          nextRetryAt: discovered.type === "disabled" ? null : now(),
        };
      }
      // Fast discovery may also settle newly queued work, within the remaining run budget.
      const last =
        discovered.checked === 0
          ? { retried: 0, pauseUntil: null }
          : await retryPublisherRemovals(context);
      const retried = first.retried + last.retried;
      if (last.pauseUntil !== null) {
        return {
          type: "paused",
          checked: discovered.checked,
          retried,
          resumeAt: last.pauseUntil,
          nextRetryAt: last.pauseUntil,
        };
      }
      return {
        ...discovered,
        retried,
        nextRetryAt:
          clock() >= deadline
            ? now()
            : await nextRemovalRetryAt(scopedDb, sourceId),
      };
    },
    catch: (cause) =>
      new DatabaseError({
        message: "Publisher removal reconciliation did not complete",
        cause,
      }),
  });
