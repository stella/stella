import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { Temporal } from "@stll/time";

import { user } from "@/api/db/auth-schema";
import { auditLogs, chatMessages, chatTurns } from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const ACTIVITY_STATEMENT_TIMEOUT_MS = 2000;

export const ACTIVITY_UNAVAILABLE_REASONS = {
  tool_calls_1h:
    "No durable tool-call event source records execution timestamps.",
} as const;

export type OperatorActivitySummary = {
  generated_at: string;
  users_acting_5m: number;
  users_acting_today: number;
  signups_today: number;
  signups_7d: number;
  chat_turns_1h: number;
  tool_calls_1h: null;
  unavailable_reasons: typeof ACTIVITY_UNAVAILABLE_REASONS;
};

type ActivityTransaction = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "select" | "insert" | "execute"
>;
type ActivityDatabase = {
  transaction: <T>(read: (tx: ActivityTransaction) => Promise<T>) => Promise<T>;
};

const USER_CHAT_ROLE = "user";
const USER_AUDIT_PERFORMER_TYPE = "user";

type ActingUsersWindow = { since: string; until: string };

// UNION deduplicates the same performer across both sources and organizations.
// The audit actor expression matches the activity feed's persisted attribution.
const countActingUsers = ({ since, until }: ActingUsersWindow) => sql<number>`(
  SELECT count(*)::float8 FROM (
    SELECT ${chatMessages.userId} AS actor FROM ${chatMessages}
    WHERE ${chatMessages.role} = ${USER_CHAT_ROLE}
      AND ${chatMessages.createdAt} >= ${since}::timestamptz
      AND ${chatMessages.createdAt} < ${until}::timestamptz
    UNION
    SELECT coalesce(${auditLogs.performerId}, ${auditLogs.userId}) AS actor FROM ${auditLogs}
    WHERE ${auditLogs.performerType} = ${USER_AUDIT_PERFORMER_TYPE}
      AND ${auditLogs.createdAt} >= ${since}::timestamptz
      AND ${auditLogs.createdAt} < ${until}::timestamptz
  ) AS acting_users
)`;

// Deployment-wide counts deliberately cross tenant boundaries on the owner
// connection. Only aggregates leave this operation; the audit commits with it.
export const readAuditedActivitySummary = async (
  db: ActivityDatabase,
  now: number,
): Promise<OperatorActivitySummary> => {
  const instant = Temporal.Instant.fromEpochMilliseconds(now);
  const dayStart = instant
    .toZonedDateTimeISO("Europe/Prague")
    .startOfDay()
    .toInstant()
    .toString();
  const weekStart = instant.subtract({ hours: 7 * 24 }).toString();
  const fiveMinuteStart = instant.subtract({ minutes: 5 }).toString();
  const hourStart = instant.subtract({ hours: 1 }).toString();
  const generatedAt = instant.toString();
  return await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, ACTIVITY_STATEMENT_TIMEOUT_MS);
    const rows = await tx
      .select({
        users_acting_5m: countActingUsers({
          since: fiveMinuteStart,
          until: generatedAt,
        }),
        users_acting_today: countActingUsers({
          since: dayStart,
          until: generatedAt,
        }),
        signups_today: sql<number>`(SELECT count(*)::float8 FROM ${user} WHERE ${user.createdAt} >= ${dayStart}::timestamptz AND ${user.createdAt} < ${generatedAt}::timestamptz AND ${user.deletedAt} IS NULL)`,
        signups_7d: sql<number>`(SELECT count(*)::float8 FROM ${user} WHERE ${user.createdAt} >= ${weekStart}::timestamptz AND ${user.createdAt} < ${generatedAt}::timestamptz AND ${user.deletedAt} IS NULL)`,
        chat_turns_1h: sql<number>`(SELECT count(*)::float8 FROM ${chatTurns} WHERE ${chatTurns.createdAt} >= ${hourStart}::timestamptz AND ${chatTurns.createdAt} < ${generatedAt}::timestamptz)`,
      })
      .from(sql`(SELECT 1) AS activity`);
    const counts = rows.at(0);
    if (
      counts === undefined ||
      Object.values(counts).some(
        (count) => !Number.isSafeInteger(count) || count < 0,
      )
    ) {
      return panic(
        "Operator activity counts must be non-negative safe integers",
      );
    }
    await recordSystemAudit(tx, "system:operator-activity", {
      subject: createSafeId<"systemScriptRun">(),
      counts: { reads: 1 },
    });
    return {
      generated_at: generatedAt,
      users_acting_5m: counts.users_acting_5m,
      users_acting_today: counts.users_acting_today,
      signups_today: counts.signups_today,
      signups_7d: counts.signups_7d,
      chat_turns_1h: counts.chat_turns_1h,
      tool_calls_1h: null,
      unavailable_reasons: ACTIVITY_UNAVAILABLE_REASONS,
    };
  });
};
