/**
 * When a case-law source stops asking its publisher: the park.
 *
 * The cycle backoff tops out at a minute and lives in the runner's loop, so a
 * restarted worker starts it again: an adapter whose parser rejects a
 * publisher's answer would refetch that answer all day. A failure that
 * outlasts any retry is read from the stored cycle events, which survive a
 * restart, and the adapter then asks once a day. That daily attempt is also
 * how it recovers: a deployed fix, or a publisher back from a long outage,
 * ends the run on the next attempt.
 *
 * Nothing here decides why a cycle failed. The same error, with no page
 * stored, over many cycles and many hours is the whole evidence, so a short
 * outage never parks a source and an error whose text varies never does
 * either.
 *
 * One definition serves the runner, which acts on a park, and the ingestion
 * report, which states it: a parked source ingests nothing for a day at a
 * time, and the operator reading the report must see that rather than infer
 * it from a failed last event.
 */
import { and, desc, eq, inArray, min, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawIngestionEvents, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

const HOUR_IN_MS = 60 * 60 * 1000;

/** Fewer identical failures than this can still be bad luck. */
export const ADAPTER_PARK_MIN_CYCLES = 5;
/** Longer than an ordinary publisher outage or maintenance window. */
export const ADAPTER_PARK_MIN_DURATION_MS = 6 * HOUR_IN_MS;
/** How often a parked adapter asks the publisher again. */
export const ADAPTER_PARK_ATTEMPT_INTERVAL_MS = DAY_IN_MS;
/** How often a parked loop wakes to keep its health and heartbeat current. */
export const ADAPTER_PARK_RECHECK_MS = 15 * 60 * 1000;

export type AdapterFailureRun = {
  errorMessage: string;
  cycles: number;
  startedAtMs: number;
  lastAtMs: number;
};

export type AdapterPark = {
  errorMessage: string;
  cycles: number;
  /** When the run of identical failures that parked the source began. */
  failingSinceMs: number;
  untilMs: number;
};

/** Null when the adapter may run a cycle now. */
export const adapterParkOf = (
  run: AdapterFailureRun | null,
  nowMs: number,
): AdapterPark | null => {
  if (
    run === null ||
    run.cycles < ADAPTER_PARK_MIN_CYCLES ||
    run.lastAtMs - run.startedAtMs < ADAPTER_PARK_MIN_DURATION_MS
  ) {
    return null;
  }
  const untilMs = run.lastAtMs + ADAPTER_PARK_ATTEMPT_INTERVAL_MS;
  return untilMs > nowMs
    ? {
        errorMessage: run.errorMessage,
        cycles: run.cycles,
        failingSinceMs: run.startedAtMs,
        untilMs,
      }
    : null;
};

/**
 * The unbroken run of identical failed cycles each source's latest event
 * ends, for every source whose latest event failed, stored no page and
 * carries a message; any other source is absent from the map. One statement
 * for the whole set: each source reads its latest event, its latest event
 * outside the run, and the run between them, all on the latest-first index
 * on source and finish time. The boundary is compared in Postgres, at the
 * column's microsecond precision, never as a millisecond JS Date.
 */
export const readAdapterFailureRunsIn = async (
  tx: Transaction,
  sourceIds: readonly SafeId<"caseLawSource">[],
): Promise<Map<SafeId<"caseLawSource">, AdapterFailureRun>> => {
  if (sourceIds.length === 0) {
    return new Map();
  }
  const events = caseLawIngestionEvents;
  const latest = tx
    .select({
      status: events.status,
      pagesProcessed: events.pagesProcessed,
      errorMessage: events.errorMessage,
      finishedAt: events.finishedAt,
    })
    .from(events)
    .where(eq(events.sourceId, caseLawSources.id))
    .orderBy(desc(events.finishedAt), desc(events.id))
    .limit(1)
    .as("latest_event");
  const lastOther = tx
    .select({ finishedAt: events.finishedAt })
    .from(events)
    .where(
      and(
        eq(events.sourceId, caseLawSources.id),
        sql`NOT (${events.status} = 'failed'
          AND ${events.pagesProcessed} = 0
          AND ${events.errorMessage} IS NOT DISTINCT FROM ${latest.errorMessage})`,
      ),
    )
    .orderBy(desc(events.finishedAt), desc(events.id))
    .limit(1)
    .as("last_other_event");
  const run = tx
    .select({
      cycles: sql<number>`count(*)::int`.as("cycles"),
      startedAt: min(events.finishedAt).as("started_at"),
    })
    .from(events)
    .where(
      and(
        eq(events.sourceId, caseLawSources.id),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are columns compared inside Postgres; no Date is round-tripped
        sql`(${lastOther.finishedAt} IS NULL OR ${events.finishedAt} > ${lastOther.finishedAt})`,
      ),
    )
    .as("failure_run");

  const rows = await tx
    .select({
      sourceId: caseLawSources.id,
      status: latest.status,
      pagesProcessed: latest.pagesProcessed,
      errorMessage: latest.errorMessage,
      lastAt: latest.finishedAt,
      cycles: run.cycles,
      startedAt: run.startedAt,
    })
    .from(caseLawSources)
    .innerJoinLateral(latest, sql`true`)
    .leftJoinLateral(lastOther, sql`true`)
    .innerJoinLateral(run, sql`true`)
    .where(inArray(caseLawSources.id, [...sourceIds]));

  const runs = new Map<SafeId<"caseLawSource">, AdapterFailureRun>();
  for (const row of rows) {
    if (
      row.status !== "failed" ||
      row.pagesProcessed > 0 ||
      row.errorMessage === null ||
      row.startedAt === null
    ) {
      continue;
    }
    runs.set(row.sourceId, {
      errorMessage: row.errorMessage,
      cycles: row.cycles,
      startedAtMs: new Date(row.startedAt).getTime(),
      lastAtMs: new Date(row.lastAt).getTime(),
    });
  }
  return runs;
};

/** The failure run of one source; see {@link readAdapterFailureRunsIn}. */
export const readAdapterFailureRun = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<AdapterFailureRun | null> =>
  await scopedDb(
    async (tx) =>
      (await readAdapterFailureRunsIn(tx, [sourceId])).get(sourceId) ?? null,
  );
