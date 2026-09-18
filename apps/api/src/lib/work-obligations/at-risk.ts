import { and, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { WORK_OBLIGATION_STATUS, workObligations } from "@/api/db/schema";

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
