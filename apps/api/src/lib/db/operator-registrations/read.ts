import { and, asc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import { createSafeId } from "@/api/lib/branded-types";
import { createCursorPage, encodePaginationCursor } from "@/api/lib/pagination";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import type { RegistrationQuery } from "./input";

type RegistrationReadDb = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "select" | "selectDistinctOn"
>;
type RegistrationTransaction = RegistrationReadDb &
  Pick<PgAsyncDatabase<PgQueryResultHKT>, "insert">;
type RegistrationDatabase = {
  transaction: <T>(
    read: (tx: RegistrationTransaction) => Promise<T>,
  ) => Promise<T>;
};

// The deployment operator reads the registration directory across organizations.
// The query receives only read methods; the transaction's sole write is its audit.
const readRegistrationPage = async (
  db: RegistrationReadDb,
  query: RegistrationQuery,
) => {
  const position = query.cursor;
  // Postgres rounds fractional microseconds; the inclusive lower bound must
  // round upward so it cannot admit a registration before the requested instant.
  const lowerBound = Temporal.Instant.from(query.since)
    .round({ smallestUnit: "microsecond", roundingMode: "ceil" })
    .toString();
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      // Date truncates Postgres microseconds, which would repeat a keyset boundary.
      created_at: sql<string>`to_char(${user.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(user)
    .where(
      and(
        isNull(user.deletedAt),
        gte(user.createdAt, sql`${lowerBound}::timestamptz`),
        position === null
          ? undefined
          : or(
              gt(user.createdAt, sql`${position.createdAt}::timestamptz`),
              and(
                eq(user.createdAt, sql`${position.createdAt}::timestamptz`),
                gt(user.id, position.id),
              ),
            ),
      ),
    )
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(query.limit + 1);

  const page = createCursorPage({
    rows,
    limit: query.limit,
    cursorForItem: (row) =>
      encodePaginationCursor([query.since, row.created_at, row.id]),
  });
  const memberships =
    page.items.length === 0
      ? []
      : await db
          .selectDistinctOn([member.userId], {
            userId: member.userId,
            id: organization.id,
            name: organization.name,
          })
          .from(member)
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .where(
            inArray(
              member.userId,
              page.items.map(({ id }) => id),
            ),
          )
          .orderBy(asc(member.userId), asc(member.createdAt), asc(member.id))
          .limit(query.limit);
  const organizations = new Map(
    memberships.map((membership) => [
      membership.userId,
      { id: membership.id, name: membership.name },
    ]),
  );
  return {
    items: page.items.map(({ id, name, email, created_at }) => ({
      name,
      email,
      organization: organizations.get(id) ?? null,
      created_at,
    })),
    nextCursor: page.nextCursor,
    limit: page.limit,
  };
};

export const readAuditedRegistrationPage = async (
  db: RegistrationDatabase,
  query: RegistrationQuery,
) =>
  await db.transaction(async (tx) => {
    const page = await readRegistrationPage(tx, query);
    await recordSystemAudit(tx, "system:operator-registrations", {
      subject: createSafeId<"systemScriptRun">(),
      counts: {
        sinceEpochMilliseconds: Temporal.Instant.from(query.since)
          .epochMilliseconds,
        pageSize: page.limit,
        returned: page.items.length,
      },
    });
    return page;
  });
