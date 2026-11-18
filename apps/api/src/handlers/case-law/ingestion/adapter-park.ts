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
import { and, count, desc, eq, gt, min, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawIngestionEvents } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";

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
 * The unbroken run of identical failed cycles the source's latest event ends,
 * or null when that event did not fail, stored a page or carries no message.
 * The latest-first index on source and finish time answers each read.
 */
export const readAdapterFailureRunIn = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
): Promise<AdapterFailureRun | null> => {
  const events = caseLawIngestionEvents;
  const latest = (
    await tx
      .select({
        status: events.status,
        pagesProcessed: events.pagesProcessed,
        errorMessage: events.errorMessage,
        finishedAt: events.finishedAt,
      })
      .from(events)
      .where(eq(events.sourceId, sourceId))
      .orderBy(desc(events.finishedAt), desc(events.id))
      .limit(1)
  ).at(0);
  if (
    latest?.status !== "failed" ||
    latest.pagesProcessed > 0 ||
    latest.errorMessage === null
  ) {
    return null;
  }
  // Read the boundary as Postgres microsecond text: a JS Date keeps only
  // milliseconds, so comparing a round-tripped Date would count the boundary
  // event itself into the run.
  const lastOther = (
    await tx
      .select({ finishedAt: pgTimestampCursorValue(events.finishedAt) })
      .from(events)
      .where(
        and(
          eq(events.sourceId, sourceId),
          sql`NOT (${events.status} = 'failed'
            AND ${events.pagesProcessed} = 0
            AND ${events.errorMessage} IS NOT DISTINCT FROM ${latest.errorMessage})`,
        ),
      )
      .orderBy(desc(events.finishedAt), desc(events.id))
      .limit(1)
  ).at(0);
  const run = (
    await tx
      .select({ cycles: count(), startedAt: min(events.finishedAt) })
      .from(events)
      .where(
        and(
          eq(events.sourceId, sourceId),
          lastOther === undefined
            ? undefined
            : gt(
                events.finishedAt,
                pgTimestampCursorBoundary({
                  type: "pgTimestampCursor",
                  value: lastOther.finishedAt,
                  precision: "microseconds",
                }),
              ),
        ),
      )
  ).at(0);
  const startedAt = run?.startedAt ?? null;
  if (run === undefined || startedAt === null) {
    return null;
  }
  return {
    errorMessage: latest.errorMessage,
    cycles: run.cycles,
    startedAtMs: startedAt.getTime(),
    lastAtMs: latest.finishedAt.getTime(),
  };
};

/** {@link readAdapterFailureRunIn} in a transaction of its own. */
export const readAdapterFailureRun = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<AdapterFailureRun | null> =>
  await scopedDb(async (tx) => await readAdapterFailureRunIn(tx, sourceId));
