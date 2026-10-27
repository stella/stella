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
import type { SafeId } from "@/api/lib/branded-types";
import type {
  AbsenceEvidence,
  ReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { removalCheckpointSchema } from "@/api/lib/legal-search/removal-reconciliation-state";
import type { RemovalCheckpoint } from "@/api/lib/legal-search/removal-reconciliation-state";

export const REMOVAL_RECONCILIATION_CONFIG_KEY = "removalReconciliation";
export const REMOVAL_SWEEP_INTERVAL_MS = 7 * DAY_IN_MS;
export const REMOVAL_SWEEP_REQUEST_BUDGET = 100;
export const REMOVAL_SWEEP_TIME_BUDGET_MS = 60_000;

export type PublisherRemovalRead =
  | Exclude<ReadOutcome<null>, { type: "absent" }>
  | {
      readonly type: "absent";
      readonly evidence: Exclude<AbsenceEvidence, "stated-zero">;
    };
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

type SweepOutcome = {
  type: "disabled" | "not-due" | "complete" | "budget" | "retry" | "contended";
  checked: number;
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

type PersistRemovalCheckpointOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  source: Pick<
    typeof caseLawSources.$inferSelect,
    "config" | "removalCheckpoint"
  >;
  next: RemovalCheckpoint | null;
};

/** A changed checkpoint or administrative control makes a stale run lose its claim. */
const persistRemovalCheckpoint = async ({
  scopedDb,
  sourceId,
  source,
  next,
}: PersistRemovalCheckpointOptions) =>
  (
    await scopedDb(
      async (tx) =>
        // audit: skip — source-scoped checkpoint for audited decision erasures.
        await tx
          .update(caseLawSources)
          .set({ removalCheckpoint: next })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              eq(caseLawSources.config, source.config ?? {}),
              source.removalCheckpoint === null
                ? isNull(caseLawSources.removalCheckpoint)
                : eq(
                    caseLawSources.removalCheckpoint,
                    source.removalCheckpoint,
                  ),
            ),
          )
          .returning({ id: caseLawSources.id }),
    )
  ).length === 1;

type InitialRemovalCheckpointOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
};

const initialRemovalCheckpoint = async ({
  scopedDb,
  sourceId,
  now,
}: InitialRemovalCheckpointOptions): Promise<RemovalCheckpoint> => {
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

/**
 * One source, bounded per invocation. Missing configuration is the kill switch.
 * Redacted rows remain in the walk: a crash after fencing replays their cleanup.
 */
export const reconcilePublisherRemovals = async ({
  scopedDb: database,
  sourceId,
  signal,
  now = () => new Date(),
  probe,
  remove = removePublisherDecision,
}: SweepOptions): Promise<Result<SweepOutcome, DatabaseError>> =>
  await Result.tryPromise({
    try: async (): Promise<Result<SweepOutcome, DatabaseError>> => {
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
      let checked = 0;
      while (
        checked < REMOVAL_SWEEP_REQUEST_BUDGET &&
        performance.now() < deadline
      ) {
        runSignal.throwIfAborted();
        // db-await-in-loop: reload the durable checkpoint and kill switch before each bounded item.
        const source = await scopedDb(async (tx) =>
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
        if (source === undefined) {
          return Result.ok({ type: "disabled", checked });
        }
        const reader =
          probe ??
          Object.entries(REMOVAL_SOURCE_PROBES).find(
            ([key]) => key === source.adapterKey,
          )?.[1];
        if (reader === undefined) {
          return Result.ok({ type: "disabled", checked });
        }
        if (
          readRemovalControl(
            source.config?.[REMOVAL_RECONCILIATION_CONFIG_KEY],
          ) === "disabled"
        ) {
          return Result.ok({ type: "disabled", checked });
        }
        const parsed = v.safeParse(
          v.nullable(removalCheckpointSchema),
          source.removalCheckpoint,
        );
        if (!parsed.success) {
          return panic("Invalid publisher removal checkpoint");
        }
        const state = parsed.output ?? { status: "ready" as const };
        const save = async (next: RemovalCheckpoint | null) =>
          await persistRemovalCheckpoint({ scopedDb, sourceId, source, next });
        switch (state.status) {
          case "waiting":
            if (
              Temporal.Instant.from(state.nextCycleAt).epochMilliseconds >
              now().getTime()
            ) {
              return Result.ok({ type: "not-due", checked });
            }
            // db-await-in-loop: compare-and-set starts the next weekly cycle.
            if (!(await save(null))) {
              return Result.ok({ type: "contended", checked });
            }
            continue;
          case "ready": {
            // db-await-in-loop: pin the upper identity bound once per weekly cycle.
            const next = await initialRemovalCheckpoint({
              scopedDb,
              sourceId,
              now: now(),
            });
            // db-await-in-loop: initialize the immutable cycle range before reading its documents.
            if (!(await save(next))) {
              return Result.ok({ type: "contended", checked });
            }
            if (next.status === "waiting") {
              return Result.ok({ type: "complete", checked });
            }
            continue;
          }
          case "running":
            break;
          default:
            state satisfies never;
            return panic("Unhandled removal checkpoint");
        }
        // db-await-in-loop: keyset pagination reads one held identity, including unfinished redactions.
        const decision = await scopedDb(async (tx) =>
          (
            await tx
              .select({
                id: caseLawDecisions.id,
                sourceDocumentId: caseLawDecisions.sourceDocumentId,
                redactedAt: caseLawDecisions.redactedAt,
              })
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
          // db-await-in-loop: completion is durable before the next weekly cycle becomes eligible.
          return Result.ok({
            type: (await save({
              status: "waiting",
              nextCycleAt: new Date(
                now().getTime() + REMOVAL_SWEEP_INTERVAL_MS,
              ).toISOString(),
            }))
              ? "complete"
              : "contended",
            checked,
          });
        }
        if (decision.sourceDocumentId === null) {
          return Result.ok({ type: "retry", checked });
        }
        // db-await-in-loop: one gated publisher request at a time, bounded by the invocation budget.
        const observation =
          decision.redactedAt === null
            ? await reader(decision.sourceDocumentId, runSignal)
            : ({
                type: "absent",
                evidence: "publisher-typed-absence",
              } as const);
        checked++;
        switch (observation.type) {
          case "present":
            break;
          case "absent": {
            // db-await-in-loop: finish external erasure before advancing beyond this identity.
            const removed = await remove({ scopedDb, decisionId: decision.id });
            if (removed.isErr()) {
              return Result.err(removed.error);
            }
            if (removed.value.type === "pending") {
              return Result.ok({ type: "retry", checked });
            }
            break;
          }
          case "refused":
          case "unavailable":
            return Result.ok({ type: "retry", checked });
          default:
            observation satisfies never;
            return panic("Unhandled publisher removal read");
        }
        runSignal.throwIfAborted();
        // db-await-in-loop: checkpoint last, guarded against another run or a changed kill switch.
        if (
          !(await save({
            status: "running",
            cursor: decision.id,
            ceiling: state.ceiling,
          }))
        ) {
          return Result.ok({ type: "contended", checked });
        }
      }
      return Result.ok({ type: "budget", checked });
    },
    catch: (cause) =>
      new DatabaseError({
        message: "Publisher removal reconciliation did not complete",
        cause,
      }),
  }).then((result) => Result.flatten(result));
