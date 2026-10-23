import { and, isNull, or, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { session } from "@/api/db/auth-schema";

export const SESSION_ABSOLUTE_AGE_MS = 90 * DAY_IN_MS;

// SQL and adapter reads derive the same expiry and creation cutoffs.
export const liveSessionAdapterWhere = (now: Date) =>
  [
    { field: "expiresAt", operator: "gt", value: now },
    {
      field: "createdAt",
      operator: "gt",
      value: new Date(now.getTime() - SESSION_ABSOLUTE_AGE_MS),
    },
  ] as const;

export const liveSessionPredicate = (now: Date, table = session) =>
  and(
    ...liveSessionAdapterWhere(now).map(
      ({ field, value }) => sql`${table[field]} > ${value}::timestamptz`,
    ),
    or(
      isNull(table.lastSeenAt),
      sql`${table.expiresAt} > ${table.lastSeenAt}::timestamptz`,
    ),
  );
