import { and, eq, isNull, or, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { entities } from "@/api/db/schema";

type WorkTaskTable = Pick<typeof entities, "kind" | "listItemType">;

/** A to-do, excluding reference entries stored in Legal Lists. */
export const workTask = (table: WorkTaskTable) =>
  sql`${and(
    eq(table.kind, "task"),
    or(isNull(table.listItemType), eq(table.listItemType, LIST_ITEM_TYPE.TASK)),
  )}`;
