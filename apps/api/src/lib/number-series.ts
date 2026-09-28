import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { renderMatterReference } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { numberSeries, numberSeriesCounters } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { toNumberPatternScopeKey } from "@/api/lib/number-pattern";

export const allocateNumber = async (
  tx: Transaction,
  seriesId: SafeId<"numberSeries">,
  issuedAt: Date,
) => {
  const rows = await tx
    .select({
      id: numberSeries.id,
      organizationId: numberSeries.organizationId,
      pattern: numberSeries.pattern,
      padding: numberSeries.padding,
    })
    .from(numberSeries)
    .where(and(eq(numberSeries.id, seriesId), isNull(numberSeries.archivedAt)))
    .for("update");
  const series = rows.at(0);
  if (!series) {
    return Result.err(
      new HandlerError({ status: 404, message: "Number series not found" }),
    );
  }
  const periodKey = toNumberPatternScopeKey(series.pattern, issuedAt);
  const counters = await tx
    .insert(numberSeriesCounters)
    .values({
      organizationId: series.organizationId,
      seriesId: series.id,
      periodKey,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [numberSeriesCounters.seriesId, numberSeriesCounters.periodKey],
      set: { lastValue: sql`${numberSeriesCounters.lastValue} + 1` },
    })
    .returning({ lastValue: numberSeriesCounters.lastValue });
  const counter = counters.at(0) ?? panic("Failed to increment number series");
  return Result.ok({
    seriesId: series.id,
    number: renderMatterReference({
      now: issuedAt,
      pattern: series.pattern,
      padding: series.padding,
      seq: counter.lastValue,
    }),
  });
};
