/**
 * Per-user lane budget counters.
 *
 * A counter row accumulates micro-units for one (org, user, kind,
 * bucket). Writes are an upsert-increment in the same transaction as
 * the usage event they settle; reads are a single point lookup. The
 * reset is structural: a new bucket has no row, and a missing row
 * reads as zero.
 */

import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { usageLaneCounters } from "@/api/db/schema";
import type { UsageLaneCounterKind } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** UTC midnight of the day containing `asOf`. */
export const utcDayStart = (asOf: Date): Date =>
  new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );

/** UTC midnight of the Monday starting the ISO week containing `asOf`. */
export const utcIsoWeekStart = (asOf: Date): Date => {
  const day = utcDayStart(asOf);
  // Both endpoints are UTC midnights, so a plain 24h duration is exact
  // (UTC has no DST).
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - daysSinceMonday * DAY_IN_MS);
};

export const laneCounterBucketStart = (
  kind: UsageLaneCounterKind,
  asOf: Date,
): Date => {
  switch (kind) {
    case "daily":
      return utcDayStart(asOf);
    case "fallback_weekly":
      return utcIsoWeekStart(asOf);
    default:
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
  }
};

type LaneCounterKey = {
  organizationId: SafeId<"organization">;
  userId: string;
  kind: UsageLaneCounterKind;
};

type IncrementLaneCounterInput = LaneCounterKey & {
  tx: Transaction;
  microUnits: number;
  asOf?: Date;
};

/**
 * Add consumed micro-units to the user's current bucket. Concurrent
 * increments serialize on the row; the first write of a bucket creates
 * it. Zero increments are skipped so idle turns never mint rows.
 */
export const incrementLaneCounter = async ({
  tx,
  organizationId,
  userId,
  kind,
  microUnits,
  asOf = new Date(),
}: IncrementLaneCounterInput): Promise<void> => {
  if (microUnits <= 0) {
    return;
  }
  const bucketStart = laneCounterBucketStart(kind, asOf);
  await tx
    .insert(usageLaneCounters)
    .values({ organizationId, userId, kind, bucketStart, microUnits })
    .onConflictDoUpdate({
      target: [
        usageLaneCounters.organizationId,
        usageLaneCounters.userId,
        usageLaneCounters.kind,
        usageLaneCounters.bucketStart,
      ],
      set: {
        microUnits: sql`${usageLaneCounters.microUnits} + ${microUnits}`,
      },
    });
};

type ReadLaneCounterInput = LaneCounterKey & {
  tx: Transaction;
  asOf?: Date;
};

/** Micro-units consumed in the user's current bucket; 0 when unused. */
export const getLaneCounterMicroUnits = async ({
  tx,
  organizationId,
  userId,
  kind,
  asOf = new Date(),
}: ReadLaneCounterInput): Promise<number> => {
  const bucketStart = laneCounterBucketStart(kind, asOf);
  const rows = await tx
    .select({ microUnits: usageLaneCounters.microUnits })
    .from(usageLaneCounters)
    .where(
      and(
        eq(usageLaneCounters.organizationId, organizationId),
        eq(usageLaneCounters.userId, userId),
        eq(usageLaneCounters.kind, kind),
        eq(usageLaneCounters.bucketStart, bucketStart),
      ),
    )
    .limit(1);
  return rows.at(0)?.microUnits ?? 0;
};
