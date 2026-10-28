import { and, eq, isNull, notInArray, or } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract";
import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { entities } from "@/api/db/schema";

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
    eq(table.kind, "task"),
    or(isNull(table.listItemType), eq(table.listItemType, LIST_ITEM_TYPE.TASK)),
    or(
      isNull(table.status),
      notInArray(table.status, [TASK_STATUS.DONE, TASK_STATUS.CANCELLED]),
    ),
  );
