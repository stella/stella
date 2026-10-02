import { asc, isNull, or, sql } from "drizzle-orm";

import { isHeldTooLong } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";

const GATE_HOLD_CAUSE = "admission_held";

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
