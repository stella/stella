import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { user } from "@/api/db/auth-schema";
import { auditLogs, chatMessages, chatThreads } from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import { ACTIVITY_TIMEZONE, buildActivityWindows } from "./calendar";

const ACTIVITY_STATEMENT_TIMEOUT_MS = 2000;
const HUMAN_ACTOR = "user";

export type OperatorActivityWeek = {
  week_start: string;
  partial: boolean;
  active_orgs: number;
  signups: number;
  new_paying: number | null;
  mrr: { currency: string; amount_minor: number } | null;
  activated_24h_pct: number | null;
  trial_to_paid_pct: number | null;
  weekly_retention_pct: number | null;
};

export type OperatorActivitySummary = {
  generated_at: string;
  timezone: typeof ACTIVITY_TIMEZONE;
  weeks: OperatorActivityWeek[];
  same_point_last_week: {
    active_orgs: number;
    signups: number;
    new_paying: number | null;
  };
  unavailable_reasons: Record<string, string>;
};

type ActivityTransaction = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "select" | "insert" | "execute"
>;
type ActivityDatabase = {
  transaction: <T>(read: (tx: ActivityTransaction) => Promise<T>) => Promise<T>;
};

// This deployment-wide read deliberately uses the owner connection. Actor and
// organization identities remain inside SQL; only aggregates leave the operation.
export const readAuditedActivitySummary = async (
  db: ActivityDatabase,
  now: number,
): Promise<OperatorActivitySummary> => {
  const windows = buildActivityWindows(now);
  const first = windows.weeks.at(0);
  if (first === undefined) {
    return panic("Operator activity requires eight weeks");
  }
  const buckets = [
    sql`(-1, ${windows.previousWeekSince}::timestamptz, ${first.since}::timestamptz)`,
    ...windows.weeks.map(
      ({ since, until }, index) =>
        sql`(${index}, ${since}::timestamptz, ${until}::timestamptz)`,
    ),
    sql`(8, ${windows.samePointLastWeek.since}::timestamptz, ${windows.samePointLastWeek.until}::timestamptz)`,
  ];
  return await db.transaction(async (tx) => {
    await setSharedStatementTimeout(tx, ACTIVITY_STATEMENT_TIMEOUT_MS);
    const rows = await tx.select({
      week_index: sql<number>`weekly.week_index`,
      active_orgs: sql<number>`weekly.active_orgs`,
      signups: sql<number>`weekly.signups`,
      activated_24h_pct: sql<number | null>`weekly.activated_24h_pct`,
      weekly_retention_pct: sql<number | null>`weekly.weekly_retention_pct`,
    }).from(sql`(
      WITH buckets (week_index, since, until) AS (VALUES ${sql.join(buckets, sql`, `)}),
      actions AS MATERIALIZED (
        SELECT ${chatThreads.organizationId} AS org_id, ${chatMessages.userId} AS actor_id, ${chatMessages.createdAt} AS acted_at
        FROM ${chatMessages} JOIN ${chatThreads} ON ${chatThreads.id} = ${chatMessages.threadId}
        WHERE ${chatMessages.role} = ${HUMAN_ACTOR}
          AND ${chatMessages.createdAt} >= ${windows.previousWeekSince}::timestamptz
          AND ${chatMessages.createdAt} < ${windows.generatedAt}::timestamptz
        UNION ALL
        SELECT ${auditLogs.organizationId}, coalesce(${auditLogs.performerId}, ${auditLogs.userId}), ${auditLogs.createdAt}
        FROM ${auditLogs} WHERE ${auditLogs.performerType} = ${HUMAN_ACTOR}
          AND ${auditLogs.createdAt} >= ${windows.previousWeekSince}::timestamptz
          AND ${auditLogs.createdAt} < ${windows.generatedAt}::timestamptz
      ),
      active AS MATERIALIZED (
        SELECT b.week_index, a.org_id FROM buckets b JOIN actions a ON a.acted_at >= b.since AND a.acted_at < b.until
        GROUP BY b.week_index, a.org_id
      ),
      signup_rows AS MATERIALIZED (
        SELECT b.week_index, ${user.id} AS user_id, ${user.createdAt} AS signed_up_at
        FROM buckets b JOIN ${user} ON ${user.createdAt} >= b.since AND ${user.createdAt} < b.until
          AND ${user.deletedAt} IS NULL AND b.week_index >= 0
      ),
      activated AS MATERIALIZED (
        SELECT s.week_index, s.user_id FROM signup_rows s JOIN actions a
          ON a.actor_id = s.user_id AND a.acted_at >= s.signed_up_at
          AND a.acted_at < s.signed_up_at + interval '24 hours'
        GROUP BY s.week_index, s.user_id
      ),
      cohorts AS (
        SELECT s.week_index, count(*)::float8 AS signups,
          (100.0 * count(a.user_id) / nullif(count(*), 0))::float8 AS activated_24h_pct
        FROM signup_rows s LEFT JOIN activated a ON a.week_index = s.week_index AND a.user_id = s.user_id
        GROUP BY s.week_index
      )
      SELECT b.week_index,
        (SELECT count(*)::float8 FROM active a WHERE a.week_index = b.week_index) AS active_orgs,
        coalesce(c.signups, 0)::float8 AS signups,
        c.activated_24h_pct,
        (100.0 * (SELECT count(*) FROM active a JOIN active p ON a.org_id = p.org_id AND p.week_index = a.week_index - 1 WHERE a.week_index = b.week_index)
          / nullif((SELECT count(*) FROM active p WHERE p.week_index = b.week_index - 1), 0))::float8 AS weekly_retention_pct
      FROM buckets b LEFT JOIN cohorts c USING (week_index)
      WHERE b.week_index >= 0 ORDER BY b.week_index
    ) AS weekly`);
    if (rows.length !== 9) {
      return panic("Operator activity requires all weekly aggregates");
    }
    const unavailable = new Map<string, string>();
    const weeks = windows.weeks.map(({ weekStart, partial }, index) => {
      const row = rows.at(index);
      if (row === undefined || row.week_index !== index) {
        return panic("Operator activity bucket order changed");
      }
      for (const count of [row.active_orgs, row.signups]) {
        if (!Number.isSafeInteger(count) || count < 0) {
          return panic(
            "Operator activity counts must be non-negative safe integers",
          );
        }
      }
      for (const percentage of [
        row.activated_24h_pct,
        row.weekly_retention_pct,
      ]) {
        if (
          percentage !== null &&
          (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
        ) {
          return panic(
            "Operator activity percentages must be finite and between zero and 100",
          );
        }
      }
      const prefix = `weeks.${weekStart}`;
      unavailable.set(
        `${prefix}.new_paying`,
        "First paid subscription start history is unavailable.",
      );
      unavailable.set(
        `${prefix}.mrr`,
        "Subscription price and lifecycle history is unavailable.",
      );
      unavailable.set(
        `${prefix}.trial_to_paid_pct`,
        "Trial outcome history is unavailable.",
      );
      if (row.activated_24h_pct === null) {
        unavailable.set(
          `${prefix}.activated_24h_pct`,
          "No signups in this week.",
        );
      }
      if (row.weekly_retention_pct === null) {
        unavailable.set(
          `${prefix}.weekly_retention_pct`,
          "No active organizations in the preceding week.",
        );
      }
      return {
        week_start: weekStart,
        partial,
        active_orgs: row.active_orgs,
        signups: row.signups,
        new_paying: null,
        mrr: null,
        activated_24h_pct: row.activated_24h_pct,
        trial_to_paid_pct: null,
        weekly_retention_pct: row.weekly_retention_pct,
      };
    });
    const samePoint = rows.at(8);
    if (samePoint === undefined || samePoint.week_index !== 8) {
      return panic("Operator activity comparison bucket required");
    }
    if (
      [samePoint.active_orgs, samePoint.signups].some(
        (count) => !Number.isSafeInteger(count) || count < 0,
      )
    ) {
      return panic(
        "Operator activity comparison counts must be non-negative safe integers",
      );
    }
    unavailable.set(
      "same_point_last_week.new_paying",
      "First paid subscription start history is unavailable.",
    );
    await recordSystemAudit(tx, "system:operator-activity", {
      subject: createSafeId<"systemScriptRun">(),
      counts: { reads: 1 },
    });
    return {
      generated_at: windows.generatedAt,
      timezone: ACTIVITY_TIMEZONE,
      weeks,
      same_point_last_week: {
        active_orgs: samePoint.active_orgs,
        signups: samePoint.signups,
        new_paying: null,
      },
      unavailable_reasons: Object.fromEntries(unavailable),
    };
  });
};
