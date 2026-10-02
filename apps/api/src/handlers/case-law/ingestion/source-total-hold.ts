import { asc, eq, isNull, or, sql } from "drizzle-orm";

import { isHeldTooLong } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

const UNKNOWN_HOLD_CAUSE = "indicators_unavailable";
const GATE_HOLD_CAUSE = "admission_held";

type RecordSourceHoldOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  slot: Date;
  admission: "held" | "unknown";
};

/** Persist every due gate hold; a row lock deduplicates UNKNOWN warnings. */
export const recordSourceStoredTotalHold = async ({
  scopedDb,
  sourceId,
  now,
  slot,
  admission,
}: RecordSourceHoldOptions) => {
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
      (row.due?.getTime() ?? 0) !== slot.getTime() ||
      (row.due !== null && row.due.getTime() > now.getTime())
    ) {
      return false;
    }
    const shouldWarn =
      admission === "unknown" && row.warnedSlot?.getTime() !== slot.getTime();
    if (row.heldSince !== null && !shouldWarn) {
      return false;
    }
    // audit: skip — public corpus refresh bookkeeping, no workspace data.
    await tx
      .update(caseLawSources)
      .set({
        storedTotalHeldSince: row.heldSince ?? now,
        storedTotalWarnedSlot: shouldWarn ? slot : row.warnedSlot,
      })
      .where(eq(caseLawSources.id, sourceId));
    return shouldWarn;
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
  holdCause: heldSince === null ? "none" : GATE_HOLD_CAUSE,
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
        .where(
          or(
            isNull(caseLawSources.storedTotalNextRefreshAt),
            sql`${caseLawSources.storedTotalNextRefreshAt} <= clock_timestamp()`,
          ),
        )
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
