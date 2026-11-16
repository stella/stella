import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { entities } from "@/api/db/schema";

import { workTask } from "./work-task";

const compiled = new PgDialect().sqlToQuery(workTask(entities));

describe("work task predicate", () => {
  test("accepts plain tasks and explicit task list items", () => {
    expect(compiled.sql).toContain('"entities"."kind" = $1');
    expect(compiled.sql).toContain('"entities"."list_item_type" is null');
    expect(compiled.sql).toContain('"entities"."list_item_type" = $2');
    expect(compiled.params).toEqual(["task", LIST_ITEM_TYPE.TASK]);
  });

  test.each([
    [null, true],
    [LIST_ITEM_TYPE.TASK, true],
    [LIST_ITEM_TYPE.FACT, false],
    [LIST_ITEM_TYPE.ISSUE, false],
    [LIST_ITEM_TYPE.REQUIREMENT, false],
    [LIST_ITEM_TYPE.EVENT, false],
  ] as const)(
    "classifies list item type %s as work: %s",
    (itemType, expected) => {
      const acceptedByCompiledPredicate =
        itemType === null || compiled.params.includes(itemType);
      expect(acceptedByCompiledPredicate).toBe(expected);
    },
  );
});
