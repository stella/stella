import { panic, Result } from "better-result";
import { and, eq, gt, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

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

type CheckVatRateOverlapOptions = {
  organizationId: SafeId<"organization">;
  code: string;
  startDate: string;
  endDate: string | null;
  excludeId?: SafeId<"vatRate">;
};

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
) => {
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
        eq(vatRates.code, code),
        isNull(vatRates.archivedAt),
        or(isNull(vatRates.validTo), gt(vatRates.validTo, startDate)),
        endDate === null ? undefined : lt(vatRates.validFrom, endDate),
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
