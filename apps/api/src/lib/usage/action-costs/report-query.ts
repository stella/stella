import { Result, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";

export const MAX_ACTION_COST_REPORT_KINDS = 512;
const MAX_REPORT_PERIOD_MS = 31 * DAY_IN_MS;
class ActionCostReportError extends TaggedError("ActionCostReportError")<{
  message: string;
}> {}

type ActionCostReportOptions = {
  organizationId: SafeId<"organization">;
  start: Date;
  end: Date;
};

// Operator-only aggregate: no customer route consumes this query. Totals remain
// numeric strings so a large period cannot overflow JavaScript's safe integers.
export const actionCostReportQuery = ({
  organizationId,
  start,
  end,
}: ActionCostReportOptions) => {
  const periodMs = end.getTime() - start.getTime();
  if (
    !Number.isFinite(periodMs) ||
    periodMs <= 0 ||
    periodMs > MAX_REPORT_PERIOD_MS
  ) {
    return Result.err(
      new ActionCostReportError({
        message: "Action cost report period is invalid",
      }),
    );
  }
  return Result.ok(sql`
    with records as (
      select * from action_cost_records
      where organization_id = ${organizationId} and admitted_at >= ${start}::timestamptz and admitted_at < ${end}::timestamptz
    ), calls as (
      select c.action_kind, c.logical_phase_id,
        count(*) as call_count,
        count(*) filter (where c.measured_micro_units is null) as unknown_call_count,
        sum(c.measured_micro_units) as measured_total,
        count(*) filter (where r.organization_id is null) as parentless_call_count
      from action_cost_calls c
      left join action_cost_records r using (organization_id, action_kind, logical_phase_id)
      where c.organization_id = ${organizationId} and c.occurred_at >= ${start}::timestamptz and c.occurred_at < ${end}::timestamptz
      group by c.action_kind, c.logical_phase_id
    ), models as (
      select action_kind, logical_phase_id, count(*) as model_count,
        count(*) filter (where raw_usage_micro_units is null) as unknown_model_count,
        sum(raw_usage_micro_units) as model_estimate_total
      from usage_events
      where organization_id = ${organizationId} and action_kind is not null
        and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz
      group by action_kind, logical_phase_id
    ), identities as (
      select action_kind, logical_phase_id from records
      union select action_kind, logical_phase_id from calls
      union select action_kind, logical_phase_id from models
    )
    select i.action_kind,
      count(r.organization_id)::text as action_count,
      count(*) filter (where r.organization_id is not null and r.estimated_micro_units is null)::text as unknown_estimate_count,
      sum(r.estimated_micro_units)::text as estimated_total,
      percentile_cont(0.5) within group (order by r.estimated_micro_units)::text as estimated_p50,
      percentile_cont(0.95) within group (order by r.estimated_micro_units)::text as estimated_p95,
      coalesce(sum(c.call_count), 0)::text as call_count,
      coalesce(sum(c.unknown_call_count), 0)::text as unknown_call_count,
      coalesce(sum(c.parentless_call_count), 0)::text as parentless_call_count,
      sum(c.measured_total)::text as measured_external_total,
      percentile_cont(0.5) within group (order by c.measured_total)
        filter (where c.unknown_call_count = 0)::text as measured_external_p50,
      percentile_cont(0.95) within group (order by c.measured_total)
        filter (where c.unknown_call_count = 0)::text as measured_external_p95,
      coalesce(sum(m.model_count), 0)::text as model_event_count,
      coalesce(sum(m.unknown_model_count), 0)::text as unknown_model_count,
      sum(m.model_estimate_total)::text as model_rate_estimate_total,
      percentile_cont(0.5) within group (order by m.model_estimate_total)
        filter (where m.unknown_model_count = 0)::text as model_rate_estimate_p50,
      percentile_cont(0.95) within group (order by m.model_estimate_total)
        filter (where m.unknown_model_count = 0)::text as model_rate_estimate_p95
    from identities i
    left join records r using (action_kind, logical_phase_id)
    left join calls c using (action_kind, logical_phase_id)
    left join models m using (action_kind, logical_phase_id)
    group by i.action_kind order by i.action_kind
    limit ${MAX_ACTION_COST_REPORT_KINDS + 1}
  `);
};
