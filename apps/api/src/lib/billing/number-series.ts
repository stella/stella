import { panic, Result } from "better-result";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { renderMatterReference } from "@stll/api-contract";
import type { InvoiceDocumentType } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import {
  numberSeries,
  numberSeriesAllocations,
  numberSeriesCounters,
} from "@/api/db/schema";
import { toNumberPatternScopeKey } from "@/api/lib/billing/number-pattern";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const allocateNumber = async (
  tx: Transaction,
  seriesId: SafeId<"numberSeries">,
  issuedAt: Date,
) => {
  const rows = await tx
    .select({
      id: numberSeries.id,
      organizationId: numberSeries.organizationId,
      documentType: numberSeries.documentType,
      pattern: numberSeries.pattern,
      padding: numberSeries.padding,
    })
    .from(numberSeries)
    .where(
      and(
        eq(numberSeries.id, seriesId),
        isNull(numberSeries.archivedAt),
        sql`${numberSeries.organizationId} = current_setting('app.organization_id', true)`,
      ),
    )
    .for("update");
  const series = rows.at(0);
  if (!series) {
    return Result.err(
      new HandlerError({ status: 404, message: "Number series not found" }),
    );
  }
  const periodKey = toNumberPatternScopeKey({
    pattern: series.pattern,
    now: issuedAt,
    timeZone: "UTC",
  });
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
  const number = renderMatterReference({
    now: issuedAt,
    pattern: series.pattern,
    padding: series.padding,
    seq: counter.lastValue,
    timeZone: "UTC",
  });
  const receipts = await tx
    .insert(numberSeriesAllocations)
    .values({
      organizationId: series.organizationId,
      seriesId: series.id,
      documentType: series.documentType,
      number,
      issuedAt,
    })
    .onConflictDoNothing()
    .returning({ number: numberSeriesAllocations.number });
  if (receipts.length === 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Number already allocated in another series",
      }),
    );
  }
  return Result.ok({
    seriesId: series.id,
    number,
  });
};

export const findDefaultNumberSeries = async (
  tx: Transaction,
  documentType: InvoiceDocumentType,
  sellerProfileId: SafeId<"sellerProfile"> | null,
) => {
  const rows = await tx
    .select({ id: numberSeries.id })
    .from(numberSeries)
    .where(
      and(
        eq(numberSeries.documentType, documentType),
        sellerProfileId === null
          ? isNull(numberSeries.sellerProfileId)
          : or(
              eq(numberSeries.sellerProfileId, sellerProfileId),
              isNull(numberSeries.sellerProfileId),
            ),
        eq(numberSeries.isDefault, true),
        isNull(numberSeries.archivedAt),
        sql`${numberSeries.organizationId} = current_setting('app.organization_id', true)`,
      ),
    )
    .orderBy(desc(sql`${numberSeries.sellerProfileId} IS NOT NULL`))
    .limit(1);
  return rows.at(0);
};
