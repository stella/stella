import { Temporal, todayFor } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import type { InvoiceSettlement } from "@/api/lib/billing/invoice-payments";

type InvoiceSettledOnOptions = {
  settlement: InvoiceSettlement;
  latestPaidOn: string | null;
  paidAt: Date | null;
  timeZone: TimeZoneId;
};

/**
 * The settlement day printed by every invoice export: the day of the latest
 * payment still counted. Only payments settle a document, so a credited one
 * has none. A document settled without a payment row (a zero document, or one
 * marked paid before payments were recorded) carries only the moment it was
 * marked.
 */
export const invoiceSettledOn = ({
  settlement,
  latestPaidOn,
  paidAt,
  timeZone,
}: InvoiceSettledOnOptions): string | null => {
  if (settlement.kind !== "paid" && settlement.kind !== "overpaid") {
    return null;
  }
  if (latestPaidOn !== null) {
    return latestPaidOn;
  }
  return paidAt === null
    ? null
    : todayFor(
        timeZone,
        Temporal.Instant.fromEpochMilliseconds(paidAt.getTime()),
      ).toString();
};
