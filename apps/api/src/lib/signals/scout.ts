import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScoutKey } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { SCOUT_RUN_STATUS, scoutRuns } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { emitSignals } from "@/api/lib/signals/emit";
import type { EmitSignalsResult, NewSignal } from "@/api/lib/signals/emit";

export type RunScoutArgs = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  scoutKey: ScoutKey;
  /** Produces signals outside the short transaction that stores them. */
  observe: () => NewSignal[] | Promise<NewSignal[]>;
  /** Revalidate mutable source ownership immediately before emission. */
  validate?: (tx: Transaction) => Promise<boolean>;
};

export type RunScoutResult = EmitSignalsResult & {
  observationAccepted: boolean;
  runId: SafeId<"scoutRun">;
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
  scoutKey,
  observe,
  validate,
}: RunScoutArgs): Promise<RunScoutResult> => {
  const runId = createSafeId<"scoutRun">();
  await db((tx) =>
    tx.insert(scoutRuns).values({
      id: runId,
      organizationId,
      scoutKey,
      status: SCOUT_RUN_STATUS.RUNNING,
    }),
  );

  let result: EmitSignalsResult;
  let observationAccepted = true;
  try {
    const proposed = await observe();
    result = await db(async (tx) => {
      observationAccepted = validate ? await validate(tx) : true;
      const emitted = await emitSignals({
        tx,
        organizationId,
        signals: observationAccepted ? proposed : [],
      });
      await tx
        .update(scoutRuns)
        .set({
          status: SCOUT_RUN_STATUS.SUCCEEDED,
          emittedCount: emitted.emittedCount,
          insertedCount: emitted.insertedIds.length,
          finishedAt: new Date(),
        })
        .where(eq(scoutRuns.id, runId));
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
              error: error instanceof Error ? error.message : String(error),
              finishedAt: new Date(),
            })
            .where(eq(scoutRuns.id, runId)),
        ),
    );
    if (Result.isError(recorded)) {
      captureError(recorded.error, {
        operation: "signals.scout.record-failure",
        runId,
      });
    }
    throw error;
  }

  return { ...result, observationAccepted, runId };
};
