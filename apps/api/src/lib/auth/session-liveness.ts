import { and, isNull, or, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { session } from "@/api/db/auth-schema";

export const SESSION_ABSOLUTE_AGE_MS = 90 * DAY_IN_MS;
// A web-link handoff session ends after this long without a request.
export const SESSION_IDLE_AGE_MS = 60 * 60 * 1000;

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
    // A startup expiration ends at lastSeenAt; earlier requests cannot reopen it.
    or(
      isNull(table.lastSeenAt),
      sql`${table.expiresAt} > ${table.lastSeenAt}::timestamptz`,
    ),
    or(
      isNull(table.handoffAbsoluteExpiresAt),
      sql`${table.handoffAbsoluteExpiresAt} > ${now}::timestamptz`,
    ),
    or(
      isNull(table.originConsentId),
      sql`COALESCE(${table.lastSeenAt}, ${table.createdAt}) > ${new Date(now.getTime() - SESSION_IDLE_AGE_MS)}::timestamptz`,
    ),
  );
