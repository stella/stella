import { asc, eq } from "drizzle-orm";

import { isHeldTooLong } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

const UNKNOWN_HOLD_CAUSE = "indicators_unavailable";

type RecordUnknownHoldOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  slot: Date;
};

/** A row lock deduplicates warnings across cycles, workers and restarts. */
export const recordSourceStoredTotalUnknownHold = async ({
  scopedDb,
  sourceId,
  now,
  slot,
}: RecordUnknownHoldOptions) => {
  const warn = await scopedDb(async (tx) => {
    const row = (
      await tx
        .select({
          due: caseLawSources.storedTotalNextRefreshAt,
          heldSince: caseLawSources.storedTotalHeldSince,
          warnedSlot: caseLawSources.storedTotalWarnedSlot,
        })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
        .for("update")
    ).at(0);
    if (
      row === undefined ||
      (row.due !== null && row.due.getTime() !== slot.getTime())
    ) {
      return false;
    }
    if (row.warnedSlot?.getTime() === slot.getTime()) {
      return false;
    }
    // audit: skip — public corpus refresh bookkeeping, no workspace data.
    await tx
      .update(caseLawSources)
      .set({
        storedTotalHeldSince: row.heldSince ?? now,
        storedTotalWarnedSlot: slot,
      })
      .where(eq(caseLawSources.id, sourceId));
    return true;
  });
  if (warn) {
    logger.warn("case_law.source_stored_total.held_unknown", {
      sourceId,
      holdCause: UNKNOWN_HOLD_CAUSE,
      slot: slot.toISOString(),
    });
  }
};

type SourceHoldHeartbeatOptions = {
  heldSince: Date | null;
  now: number;
};

/** Uses the backfill alarm's existing namespace, dimension and yielded gauge. */
export const sourceStoredTotalHoldHeartbeat = ({
  heldSince,
  now,
}: SourceHoldHeartbeatOptions) => ({
  _aws: {
    Timestamp: now,
    CloudWatchMetrics: [
      {
        Namespace: "Stella/Backfill",
        Dimensions: [["Backfill"]],
        Metrics: [{ Name: "BackfillYielded", Unit: "Count" }],
      },
    ],
  },
  Backfill: "caseLaw.sourceStoredTotal",
  BackfillYielded: heldSince === null ? 0 : 1,
  heldSince: heldSince?.getTime() ?? null,
  heldTooLong: isHeldTooLong({ heldSince: heldSince?.getTime() ?? null }, now),
  holdCause: heldSince === null ? "none" : UNKNOWN_HOLD_CAUSE,
});

export const emitSourceStoredTotalHoldHeartbeats = async (
  scopedDb: ScopedDb,
) => {
  const row = await scopedDb(async (tx) =>
    (
      await tx
        .select({
          heldSince: caseLawSources.storedTotalHeldSince,
        })
        .from(caseLawSources)
        .orderBy(asc(caseLawSources.storedTotalHeldSince))
        .limit(1)
    ).at(0),
  );
  // EMF must be at the log root to be consumed by CloudWatch.
  process.stdout.write(
    `${JSON.stringify(
      sourceStoredTotalHoldHeartbeat({
        heldSince: row?.heldSince ?? null,
        now: Temporal.Now.instant().epochMilliseconds,
      }),
    )}\n`,
  );
};
