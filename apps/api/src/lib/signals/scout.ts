import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ScoutKey } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { SCOUT_RUN_STATUS, scoutRuns } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { errorTag } from "@/api/lib/errors/error-tag";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { emitSignals } from "@/api/lib/signals/emit";
import type { EmitSignalsResult, NewSignal } from "@/api/lib/signals/emit";

export type RunScoutArgs = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scoutKey: ScoutKey;
  /** Produces signals outside the short transaction that stores them. */
  observe: () => NewSignal[] | Promise<NewSignal[]>;
  /** Revalidate mutable source ownership immediately before emission. */
  validate?: (tx: Transaction) => Promise<boolean>;
  /**
   * Drop the individual signals whose source stopped qualifying between the
   * observation and this transaction. `validate` accepts or rejects a whole
   * observation of one source; this keeps the still-warranted signals of an
   * observation that spans many independent ones.
   */
  screen?: (tx: Transaction, proposed: NewSignal[]) => Promise<NewSignal[]>;
  /** Settle accepted source claims atomically with their emitted signals. */
  settle?: (
    tx: Transaction,
    admission: { observationAccepted: boolean; featureEnabled: boolean },
  ) => Promise<void>;
};

export type RunScoutResult = EmitSignalsResult & {
  observationAccepted: boolean;
  runId: SafeId<"scoutRun"> | null;
  outcome: "emitted" | "paused" | "stale";
};

/**
 * Execute one scout for one organization and record the run in the census,
 * so "no signals" and "never ran" stay distinguishable. The run row is
 * opened in its own transaction and closed after the observe+emit
 * transaction settles, so a failed observation still leaves a `failed` row.
 */
export const runScout = async ({
  db,
  organizationId,
  userId,
  scoutKey,
  observe,
  validate,
  screen,
  settle,
}: RunScoutArgs): Promise<RunScoutResult> => {
  const runId = createSafeId<"scoutRun">();
  const startedAt = new Date();
  const claim = and(
    eq(scoutRuns.id, runId),
    eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
    eq(scoutRuns.startedAt, startedAt),
  );
  const admitted = await db(async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "signals",
    });
    if (
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId,
        userId,
        featureId: "signals",
      }))
    ) {
      return false;
    }
    await tx.insert(scoutRuns).values({
      id: runId,
      organizationId,
      scoutKey,
      startedAt,
      status: SCOUT_RUN_STATUS.RUNNING,
    });
    return true;
  });
  if (!admitted) {
    return {
      insertedIds: [],
      emittedCount: 0,
      observationAccepted: false,
      runId: null,
      outcome: "paused",
    };
  }

  let result: EmitSignalsResult;
  let observationAccepted = true;
  let outcome: RunScoutResult["outcome"] = "emitted";
  try {
    const proposed = await observe();
    result = await db(async (tx) => {
      await lockFeatureRecoveryAdmission({
        tx,
        organizationId,
        featureId: "signals",
      });
      const owned = await withAggregateRowQuery({
        aggregate: "scoutCensus",
        id: { type: "run", id: runId, organizationId },
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              id: scoutRuns.id,
              organizationId: scoutRuns.organizationId,
            })
            .from(scoutRuns)
            .limit(1),
        where: claim,
      });
      if (owned.status === "busy") {
        panic("Blocking aggregate acquisition returned busy");
      }
      if (!owned.rows.at(0)) {
        observationAccepted = false;
        outcome = "stale";
        return { insertedIds: [], emittedCount: 0 };
      }
      const enabled = await isBackgroundFeatureEnabled({
        tx,
        organizationId,
        userId,
        featureId: "signals",
      });
      observationAccepted = enabled && (validate ? await validate(tx) : true);
      if (!observationAccepted) {
        outcome = "paused";
      }
      let acceptedSignals = observationAccepted ? proposed : [];
      if (screen && acceptedSignals.length > 0) {
        acceptedSignals = await screen(tx, acceptedSignals);
      }
      const emitted = await emitSignals({
        tx,
        organizationId,
        signals: acceptedSignals,
      });
      await tx
        .update(scoutRuns)
        .set({
          status: SCOUT_RUN_STATUS.SUCCEEDED,
          emittedCount: emitted.emittedCount,
          insertedCount: emitted.insertedIds.length,
          finishedAt: new Date(),
        })
        .where(claim);
      await settle?.(tx, { observationAccepted, featureEnabled: enabled });
      return emitted;
    });
  } catch (error) {
    const recorded = await Result.tryPromise(
      async () =>
        await db((tx) =>
          tx
            .update(scoutRuns)
            .set({
              status: SCOUT_RUN_STATUS.FAILED,
              // The structural name only: an observation's message can
              // quote model output or document text.
              error: errorTag(error),
              finishedAt: new Date(),
            })
            .where(claim)
            .returning({ id: scoutRuns.id }),
        ),
    );
    if (Result.isError(recorded)) {
      captureError(recorded.error, {
        operation: "signals.scout.record-failure",
        runId,
      });
    } else if (!recorded.value.at(0)) {
      return {
        insertedIds: [],
        emittedCount: 0,
        observationAccepted: false,
        runId,
        outcome: "stale",
      };
    }
    throw error;
  }

  return { ...result, observationAccepted, runId, outcome };
};
