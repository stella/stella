import { INVOICE_STATUS } from "@stll/api-contract";
import { Temporal, todayFor } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

type InvoiceSettledOnOptions = {
  status: string;
  latestPaidOn: string | null;
  paidAt: Date | null;
  timeZone: TimeZoneId;
};

/** The settlement day printed by every invoice export; legacy/zero settlements may have only a timestamp. */
export const invoiceSettledOn = ({
  status,
  latestPaidOn,
  paidAt,
  timeZone,
}: InvoiceSettledOnOptions): string | null => {
  if (status !== INVOICE_STATUS.PAID) {
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
