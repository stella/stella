import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { SchedulerDb } from "@/api/lib/scheduler/types";

export const ACTION_COST_RETENTION_BATCH_SIZE = 128;

export const actionCostRetentionQueries = (cutoff: Date) => ({
  // Each pass has a fixed work envelope; durable continuations drain the remainder.
  calls: sql`
    delete from action_cost_calls where ctid in (
      select ctid from action_cost_calls where occurred_at < ${cutoff}::timestamptz
      order by occurred_at limit ${ACTION_COST_RETENTION_BATCH_SIZE} for update skip locked
    ) returning organization_id
  `,
  records: sql`
    delete from action_cost_records where ctid in (
      select ctid from action_cost_records where admitted_at < ${cutoff}::timestamptz
      order by admitted_at limit ${ACTION_COST_RETENTION_BATCH_SIZE} for update skip locked
    ) returning organization_id
  `,
});

type SweepActionCostsOptions = {
  db: SchedulerDb;
  retentionDays: number;
  now: Date;
};

export const sweepActionCosts = async ({
  db,
  retentionDays,
  now,
}: SweepActionCostsOptions) => {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_IN_MS);
  const queries = actionCostRetentionQueries(cutoff);
  const calls = await db.execute(queries.calls);
  const records = await db.execute(queries.records);
  return { callsDeleted: calls.length, recordsDeleted: records.length };
};
