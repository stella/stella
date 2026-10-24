import { panic, Result } from "better-result";
import { and, eq, gt, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { vatRates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Lock the organization even when the first period has no rows to lock.
export const lockVatRateOrganization = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:vat-rates`}, 0))`,
  );
};

export const vatRateOnDate = (on: string) =>
  and(
    lte(vatRates.validFrom, on),
    or(isNull(vatRates.validTo), gt(vatRates.validTo, on)),
  );

type ResolveVatRateOptions = {
  organizationId: SafeId<"organization">;
  code: string;
  on: string;
};

export const resolveVatRate = async (
  tx: Transaction,
  { organizationId, code, on }: ResolveVatRateOptions,
) => {
  const rows = await tx
    .select()
    .from(vatRates)
    .where(
      and(
        eq(vatRates.organizationId, organizationId),
        eq(vatRates.code, code),
        isNull(vatRates.archivedAt),
        vatRateOnDate(on),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    panic("Overlapping VAT rate periods");
  }
  const row = rows.at(0);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "VAT rate not found for date" }),
    );
  }
  return Result.ok(row);
};

type OverlapOperands = {
  code: SQL | string;
  startDate: SQL | string;
  endDate: SQL | string | null;
};

// A candidate's open end (null value or NULL column) overlaps every later start.
const startsBeforeEndOf = (endDate: SQL | string | null) => {
  if (endDate === null) {
    return undefined;
  }
  if (typeof endDate === "string") {
    return lt(vatRates.validFrom, endDate);
  }
  return or(isNull(endDate), lt(vatRates.validFrom, endDate));
};

// The one overlap rule for VAT rate periods: a live period [validFrom, validTo)
// with the same code, where an open validTo never ends. Operands are values or
// columns of a candidate list.
const overlapsLiveVatRate = ({ code, startDate, endDate }: OverlapOperands) =>
  and(
    eq(vatRates.code, code),
    isNull(vatRates.archivedAt),
    or(isNull(vatRates.validTo), gt(vatRates.validTo, startDate)),
    startsBeforeEndOf(endDate),
  );

type VatRatePeriod = {
  code: string;
  validFrom: string;
  validTo: string | null;
};

type OverlappingVatRatePeriodsOptions = {
  organizationId: SafeId<"organization">;
  periods: readonly VatRatePeriod[];
};

// Positions of the periods that overlap a live period, in one query.
// Call after lockVatRateOrganization in the same mutation transaction.
export const overlappingVatRatePeriods = async (
  tx: Transaction,
  { organizationId, periods }: OverlappingVatRatePeriodsOptions,
): Promise<ReadonlySet<number>> => {
  if (periods.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({ position: sql<number>`candidate.position` })
    .from(
      sql`(VALUES ${sql.join(
        periods.map(
          (period, position) =>
            sql`(${position}::int, ${period.code}::text, ${period.validFrom}::date, ${period.validTo}::date)`,
        ),
        sql.raw(","),
      )}) AS candidate(position, code, valid_from, valid_to)`,
    )
    .where(
      sql`EXISTS (SELECT 1 FROM ${vatRates} WHERE ${and(
        eq(vatRates.organizationId, organizationId),
        overlapsLiveVatRate({
          code: sql.raw("candidate.code"),
          startDate: sql.raw("candidate.valid_from"),
          endDate: sql.raw("candidate.valid_to"),
        }),
      )})`,
    );
  return new Set(rows.map(({ position }) => position));
};

type CheckVatRateOverlapOptions = {
  organizationId: SafeId<"organization">;
  code: string;
  startDate: string;
  endDate: string | null;
  excludeId?: SafeId<"vatRate">;
};

type CheckVatRateOverlapResult = Result<
  void,
  HandlerError<400> | HandlerError<409>
>;

// Call after lockVatRateOrganization in the same mutation transaction.
export const checkVatRateOverlap = async (
  tx: Transaction,
  {
    organizationId,
    code,
    startDate,
    endDate,
    excludeId,
  }: CheckVatRateOverlapOptions,
): Promise<CheckVatRateOverlapResult> => {
  if (endDate !== null && endDate <= startDate) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Validity end must be after start",
      }),
    );
  }
  const rows = await tx
    .select({ id: vatRates.id })
    .from(vatRates)
    .where(
      and(
        eq(vatRates.organizationId, organizationId),
        overlapsLiveVatRate({ code, startDate, endDate }),
        excludeId === undefined ? undefined : ne(vatRates.id, excludeId),
      ),
    )
    .limit(1);
  if (rows.length > 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "VAT rate validity overlaps an existing period",
      }),
    );
  }
  return Result.ok();
};
