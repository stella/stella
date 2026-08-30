import { sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { entities } from "@/api/db/schema";

/**
 * Governed work is only ever attached to an actionable row. A task entity that
 * carries a legal-list discriminator of `fact`, `issue`, `requirement` or
 * `event` is reference material: it has no owner, no deadline and no place in
 * My Work, so it must never gain a work obligation. A null discriminator is a
 * plain task that never belonged to a List.
 */
export const isWorkObligationEligible = (
  listItemType: string | null,
): boolean => listItemType === null || listItemType === LIST_ITEM_TYPE.TASK;

/** The same predicate, for queries over `entities`. */
export const workObligationEligibleEntity = sql`(${entities.listItemType} IS NULL OR ${entities.listItemType} = ${LIST_ITEM_TYPE.TASK})`;
