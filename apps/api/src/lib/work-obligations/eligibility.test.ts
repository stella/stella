import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  LIST_ITEM_TYPE,
  LIST_ITEM_TYPES,
} from "@stll/api-contract/entity-options";

import {
  isWorkObligationEligible,
  workObligationEligibleEntity,
} from "@/api/lib/work-obligations/eligibility";

describe("work-obligation eligibility", () => {
  test("admits only the actionable list item type", () => {
    expect(LIST_ITEM_TYPES.filter(isWorkObligationEligible)).toEqual([
      LIST_ITEM_TYPE.TASK,
    ]);
  });

  test("admits a task that never belonged to a List", () => {
    expect(isWorkObligationEligible(null)).toBe(true);
  });

  test("the SQL condition reads the same column and value as the predicate", () => {
    const query = new PgDialect().sqlToQuery(workObligationEligibleEntity);

    expect(query.sql).toBe(
      `("entities"."list_item_type" IS NULL OR "entities"."list_item_type" = $1)`,
    );
    expect(query.params).toEqual([LIST_ITEM_TYPE.TASK]);
  });
});
