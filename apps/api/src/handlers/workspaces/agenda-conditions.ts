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
