import { addDays, parseIsoDateLocal } from "@/lib/dates";

type AuditLogDateRangeInput = {
  from: string | null;
  to: string | null;
};

type AuditLogDateRange = {
  from?: string;
  toExclusive?: string;
};

export const toAuditLogDateRange = ({
  from,
  to,
}: AuditLogDateRangeInput): AuditLogDateRange => {
  const range: AuditLogDateRange = {};
  const fromDate = from === null ? null : parseIsoDateLocal(from);
  const toDate = to === null ? null : parseIsoDateLocal(to);

  if (fromDate !== null) {
    range.from = fromDate.toISOString();
  }
  if (toDate !== null) {
    range.toExclusive = addDays(toDate, 1).toISOString();
  }

  return range;
};
