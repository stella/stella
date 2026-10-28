import { and, gte, isNull, notInArray, or, sql } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract";

import type { entities } from "@/api/db/schema";
import { workTask } from "@/api/lib/tasks/work-task";

/**
 * The entities table as a query sees it: the table itself in a builder query,
 * or the aliased table a relational query hands to its `RAW` filter.
 */
type EntitiesTable = typeof entities;

/**
 * An entity on a matter's agenda: a plain task or a task list item (never a
 * fact or other reference row) that is not done or cancelled. Every agenda
 * surface reads through this, so they cannot disagree.
 */
export const openAgendaTask = (table: EntitiesTable) =>
  and(
    workTask(table),
    or(
      isNull(table.status),
      notInArray(table.status, [TASK_STATUS.DONE, TASK_STATUS.CANCELLED]),
    ),
  );

/** Due today or later in the database's calendar. */
export const dueFromToday = (table: EntitiesTable) =>
  gte(table.dueDate, sql`CURRENT_DATE`);

/**
 * Due on or after the reader's local date. A reader's date differs from the
 * database's by at most a day either way, so a value outside that window is
 * clamped to it; without one, the database's today applies.
 */
export const dueFromReaderDate = (
  table: EntitiesTable,
  readerDate: string | undefined,
) =>
  readerDate === undefined
    ? dueFromToday(table)
    : gte(
        table.dueDate,
        sql`GREATEST(LEAST(${readerDate}::date, CURRENT_DATE + 1), CURRENT_DATE - 1)`,
      );
