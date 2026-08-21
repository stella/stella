import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { SCOUT_RUN_STATUS, scoutRuns } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { emitSignals } from "@/api/lib/signals/emit";
import type { EmitSignalsResult, NewSignal } from "@/api/lib/signals/emit";

/** Closed registry of producers; every emitted signal names one of these. */
export const SCOUT_KEY = {
  MANUAL_REQUEST: "manual.request",
  INFOSOUD_HEARINGS: "infosoud.hearings",
  DOCUMENT_DEADLINES: "document.deadlines",
  DOCUMENT_REVIEW: "document.review",
} as const;
export type ScoutKey = (typeof SCOUT_KEY)[keyof typeof SCOUT_KEY];

export type RunScoutArgs = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  scoutKey: ScoutKey;
  /** Produces signals; runs inside the same transaction that stores them. */
  observe: (tx: Transaction) => Promise<NewSignal[]>;
};

export type RunScoutResult = EmitSignalsResult & {
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
  try {
    result = await db(async (tx) => {
      const proposed = await observe(tx);
      return emitSignals({ tx, organizationId, signals: proposed });
    });
  } catch (error) {
    await db((tx) =>
      tx
        .update(scoutRuns)
        .set({
          status: SCOUT_RUN_STATUS.FAILED,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        })
        .where(eq(scoutRuns.id, runId)),
    );
    throw error;
  }

  await db((tx) =>
    tx
      .update(scoutRuns)
      .set({
        status: SCOUT_RUN_STATUS.SUCCEEDED,
        emittedCount: result.emittedCount,
        insertedCount: result.insertedIds.length,
        finishedAt: new Date(),
      })
      .where(eq(scoutRuns.id, runId)),
  );

  return { ...result, runId };
};
