import { and, eq, gte, isNull, notInArray, or, sql } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract";
import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { entities } from "@/api/db/schema";

/**
 * An entity on a matter's agenda: a plain task or a task list item (never a
 * fact or other reference row) that is not done or cancelled. Every agenda
 * surface reads through this, so they cannot disagree.
 */
export const openAgendaTask = () =>
  and(
    eq(entities.kind, "task"),
    or(
      isNull(entities.listItemType),
      eq(entities.listItemType, LIST_ITEM_TYPE.TASK),
    ),
    or(
      isNull(entities.status),
      notInArray(entities.status, [TASK_STATUS.DONE, TASK_STATUS.CANCELLED]),
    ),
  );

/** Due today or later in the database's calendar. */
export const dueFromToday = () => gte(entities.dueDate, sql`CURRENT_DATE`);

/**
 * Due on or after the reader's local date. A reader's date differs from the
 * database's by at most a day either way, so a value outside that window is
 * clamped to it; without one, the database's today applies.
 */
export const dueFromReaderDate = (readerDate: string | undefined) =>
  readerDate === undefined
    ? dueFromToday()
    : gte(
        entities.dueDate,
        sql`GREATEST(LEAST(${readerDate}::date, CURRENT_DATE + 1), CURRENT_DATE - 1)`,
      );
