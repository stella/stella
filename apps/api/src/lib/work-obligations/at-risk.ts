import { Result } from "better-result";
import { and, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import { WORK_OBLIGATION_STATUS, workObligations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { entityQueryScopeCondition } from "@/api/lib/entities/query-scope";
import type { EntityQueryScope } from "@/api/lib/entities/query-scope";

/**
 * The civil date "due" is measured against: the caller's `asOf` when given
 * (their own calendar day), else the server's UTC day. `hard_deadline_date`
 * and `due_date` are dates without a time zone, so every reader of "due
 * today" resolves the day here.
 */
export const resolveWorkAsOf = (asOf: string | undefined): string =>
  asOf ??
  Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }).slice(0, 10);

const OPEN_WORK_OBLIGATION_STATUSES = [
  WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
  WORK_OBLIGATION_STATUS.ACTIVE,
];

/**
 * Whether the obligation's hard deadline or working target is already due.
 * `COALESCE` keeps a dateless obligation out of the overdue side and, negated,
 * inside it: plain three-valued logic would drop it from both.
 */
export const workObligationOverdue = (asOf: string): SQL =>
  sql`COALESCE(${workObligations.hardDeadlineDate} <= ${asOf}::date OR ${workObligations.workingTargetDate} <= ${asOf}::date, false)`;

/** At risk: still open and already due. My Work's at-risk queue and the task marker share it. */
export const workObligationAtRisk = (asOf: string): SQL =>
  and(
    inArray(workObligations.status, OPEN_WORK_OBLIGATION_STATUSES),
    workObligationOverdue(asOf),
  ) ?? sql`false`;

type ListAtRiskEntityIdsOptions = {
  safeDb: SafeDb;
  scope: EntityQueryScope;
  entityIds: readonly SafeId<"entity">[];
  asOf: string;
};

/** Which of a page's tasks carry an at-risk obligation, within the page's scope. */
export const listAtRiskEntityIds = async ({
  safeDb,
  scope,
  entityIds,
  asOf,
}: ListAtRiskEntityIdsOptions) => {
  const rows = await safeDb((tx) =>
    tx
      .select({ entityId: workObligations.entityId })
      .from(workObligations)
      .where(
        and(
          inArray(workObligations.entityId, [...entityIds]),
          entityQueryScopeCondition(scope, workObligations.workspaceId),
          workObligationAtRisk(asOf),
        ),
      ),
  );
  return Result.isError(rows)
    ? Result.err(rows.error)
    : Result.ok(new Set<string>(rows.value.map((row) => row.entityId)));
};
