import { panic, Result } from "better-result";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import * as v from "valibot";

import { DAY_IN_MS, Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { setSharedTransactionTimeouts } from "@/api/db/shared-pool-timeouts";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { probeUkFclRemoval } from "@/api/handlers/case-law/ingestion/adapters/uk-fcl-removal";
import { removePublisherDecision } from "@/api/handlers/case-law/publisher-removal";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawRemovalSource } from "@/api/lib/db/aggregate-lock";
import type {
  AbsenceEvidence,
  ReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
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

export const REMOVAL_RECONCILIATION_CONFIG_KEY = "removalReconciliation";
export const REMOVAL_SWEEP_INTERVAL_MS = 7 * DAY_IN_MS;
export const REMOVAL_SWEEP_REQUEST_BUDGET = 100;
export const REMOVAL_SWEEP_TIME_BUDGET_MS = 60_000;
export const REMOVAL_RETRY_PER_KIND_BUDGET = 10;

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
) => Promise<PublisherRemovalRead>;
export const REMOVAL_SOURCE_PROBES = {
  [ADAPTER_KEYS.UK_FCL]: probeUkFclRemoval,
} as const satisfies Record<string, RemovalProbe>;

type SweepOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  signal: AbortSignal;
  now?: () => Date;
  probe?: RemovalProbe;
  remove?: typeof removePublisherDecision;
};
type DiscoveryOutcome = {
  type: "disabled" | "not-due" | "complete" | "budget" | "contended";
  checked: number;
};
type SweepOutcome = DiscoveryOutcome & {
  retried: number;
  nextRetryAt: Date | null;
};
type RemovalSource = Pick<
  typeof caseLawSources.$inferSelect,
  "config" | "adapterKey" | "removalCheckpoint"
>;
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

type ProcessRemovalDecisionOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  reader: RemovalProbe;
  remove: typeof removePublisherDecision;
  signal: AbortSignal;
  mode: { type: "discovery" } | { type: "retry"; item: RemovalRetryItem };
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
}: ProcessRemovalDecisionOptions): Promise<RemovalStepOutcome> => {
  let operation: "probe" | "erase" =
    mode.type === "retry" && mode.item.payload.type === "pending"
      ? mode.item.payload.operation
      : "probe";
  const result = await Result.tryPromise({
    try: async (): Promise<RemovalStepOutcome> => {
      const decision = await scopedDb(async (tx) =>
        (
          await tx
            .select({
              sourceDocumentId: caseLawDecisions.sourceDocumentId,
              redactedAt: caseLawDecisions.redactedAt,
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
      const erasureAuthorized =
        decision.redactedAt !== null || operation === "erase";
      if (!erasureAuthorized) {
        if (decision.sourceDocumentId === null) {
          return {
            type: "unprobeable",
            reason: REMOVAL_UNPROBEABLE_REASON.MISSING_IDENTITY,
          };
        }
        const observation = await reader(decision.sourceDocumentId, signal);
        switch (observation.type) {
          case "present":
            return { type: "settled" };
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
            break;
          default:
            observation satisfies never;
            return panic("Unhandled removal observation");
        }
      }
      operation = "erase";
      if (mode.type === "discovery" || !erasureAuthorized) {
        return {
          type: "pending",
          operation: "erase",
          reason:
            decision.redactedAt === null
              ? REMOVAL_PENDING_REASON.PUBLISHER_ABSENT
              : REMOVAL_PENDING_REASON.STORES_PENDING,
        };
      }
      const removed = await remove({ scopedDb, decisionId });
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
          reason: REMOVAL_PENDING_REASON.OPERATION_FAILED,
        };
      }
      return removed.value.type === "pending"
        ? {
            type: "pending",
            operation: "erase",
            reason: REMOVAL_PENDING_REASON.STORES_PENDING,
          }
        : { type: "settled" };
    },
    catch: (cause) => cause,
  });
  if (result.isOk()) {
    return result.value;
  }
  captureError(
    result.error,
    handlerErrorContext("caseLaw.removal.operation_failed", { decisionId }),
  );
  return operation === "erase"
    ? {
        type: "pending",
        operation: "erase",
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
> &
  Pick<SweepOptions, "probe"> & { scopedDb: ScopedDb; deadline: number };
const discoverPublisherRemovals = async ({
  scopedDb,
  sourceId,
  signal,
  now,
  probe,
  remove,
  deadline,
}: DiscoveryOptions): Promise<DiscoveryOutcome> => {
  let checked = 0;
  while (
    checked < REMOVAL_SWEEP_REQUEST_BUDGET &&
    performance.now() < deadline
  ) {
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
              lte(caseLawDecisions.id, state.ceiling),
              state.cursor === null
                ? undefined
                : gt(caseLawDecisions.id, state.cursor),
            ),
          )
          .orderBy(caseLawDecisions.id)
          .limit(1)
      ).at(0),
    );
    if (decision === undefined) {
      // db-await-in-loop: the weekly enumeration can finish while deferred work remains durable.
      return {
        type: (await commit({
          status: "waiting",
          nextCycleAt: new Date(
            now().getTime() + REMOVAL_SWEEP_INTERVAL_MS,
          ).toISOString(),
        }))
          ? "complete"
          : "contended",
        checked,
      };
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
    });
    // db-await-in-loop: a deferred item is recorded atomically with advancing past it.
    if (
      !(await commit(
        { status: "running", cursor: decision.id, ceiling: state.ceiling },
        [{ decisionId: decision.id, outcome, origin: { type: "discovery" } }],
      ))
    ) {
      return { type: "contended", checked };
    }
    checked++;
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
}: RetryOptions): Promise<number> => {
  const items = await selectDueRemovalRetries({
    scopedDb,
    sourceId,
    now: now(),
    perKindLimit: REMOVAL_RETRY_PER_KIND_BUDGET,
  });
  let retried = 0;
  for (const item of items) {
    if (performance.now() >= deadline) {
      break;
    }
    signal.throwIfAborted();
    // db-await-in-loop: honor the current kill switch and source CAS before every retry.
    const source = await readSource(scopedDb, sourceId);
    if (source === undefined) {
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
    });
    // db-await-in-loop: settling a retry never rewinds the independent enumeration cursor.
    if (
      await commitRemovalProgress({
        scopedDb,
        sourceId,
        source,
        next: source.removalCheckpoint,
        items: [
          {
            decisionId: item.decisionId,
            outcome,
            origin: { type: "retry", item },
          },
        ],
        now: now(),
      })
    ) {
      retried++;
    }
  }
  return retried;
};

/** Weekly discovery and bounded durable completion share source control, not a cursor. */
export const reconcilePublisherRemovals = async ({
  scopedDb: database,
  sourceId,
  signal,
  now = () => new Date(),
  probe,
  remove = removePublisherDecision,
}: SweepOptions): Promise<Result<SweepOutcome, DatabaseError>> =>
  await Result.tryPromise({
    try: async () => {
      const deadline = performance.now() + REMOVAL_SWEEP_TIME_BUDGET_MS;
      const runSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(REMOVAL_SWEEP_TIME_BUDGET_MS),
      ]);
      const scopedDb: ScopedDb = async (run) =>
        await database(async (tx) => {
          runSignal.throwIfAborted();
          const remainingMs = Math.max(
            1,
            Math.ceil(deadline - performance.now()),
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
      };
      const discovered = await discoverPublisherRemovals(context);
      if (discovered.type === "disabled" || performance.now() >= deadline) {
        return { ...discovered, retried: 0, nextRetryAt: null };
      }
      const retried = await retryPublisherRemovals(context);
      return {
        ...discovered,
        retried,
        nextRetryAt:
          performance.now() >= deadline
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
