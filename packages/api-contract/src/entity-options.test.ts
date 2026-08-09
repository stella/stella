import { describe, expect, test } from "bun:test";

import {
  ENTITY_PRIORITIES,
  isListItemType,
  isEntityPriority,
  isTaskStatus,
  LIST_ITEM_TYPES,
  TASK_STATUSES,
} from "./entity-options";
import type {
  EntityPriority,
  ListItemType,
  TaskStatus,
} from "./entity-options";

const EXPECTED_TASK_STATUSES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];

const EXPECTED_ENTITY_PRIORITIES = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
] as const satisfies readonly EntityPriority[];

const EXPECTED_LIST_ITEM_TYPES = [
  "task",
  "fact",
  "issue",
  "requirement",
  "event",
] as const satisfies readonly ListItemType[];

describe("isTaskStatus", () => {
  test("accepts every declared status", () => {
    expect(TASK_STATUSES).toEqual(EXPECTED_TASK_STATUSES);
    expect(Object.isFrozen(TASK_STATUSES)).toBe(true);
    expect(TASK_STATUSES.filter(isTaskStatus)).toEqual([...TASK_STATUSES]);
  });

  // The guard's whole job is to keep "not a status" distinguishable from a
  // status. A near miss that slipped through (or a default substituted for
  // one) reaches the UI as a confident wrong answer rather than an
  // unresolved one.
  // Each case is wrapped in a tuple: `test.each` spreads a bare array case
  // into the callback's arguments, which would quietly test "done".
  test.each([
    ["Done"],
    ["dones"],
    ["pending"],
    [""],
    [" open"],
    [null],
    [undefined],
    [0],
    [["done"]],
    [{ status: "done" }],
  ])("rejects %p", (value) => {
    expect(isTaskStatus(value)).toBe(false);
  });
});

describe("isEntityPriority", () => {
  test("accepts every declared priority", () => {
    expect(ENTITY_PRIORITIES).toEqual(EXPECTED_ENTITY_PRIORITIES);
    expect(Object.isFrozen(ENTITY_PRIORITIES)).toBe(true);
    expect(ENTITY_PRIORITIES.filter(isEntityPriority)).toEqual([
      ...ENTITY_PRIORITIES,
    ]);
  });

  test.each([
    ["Urgent"],
    ["urgents"],
    ["critical"],
    [""],
    [" none"],
    [null],
    [undefined],
    [0],
    [["urgent"]],
    [{ priority: "urgent" }],
  ])("rejects %p", (value) => {
    expect(isEntityPriority(value)).toBe(false);
  });
});

describe("isListItemType", () => {
  test("accepts every declared list item type", () => {
    expect(LIST_ITEM_TYPES).toEqual(EXPECTED_LIST_ITEM_TYPES);
    expect(Object.isFrozen(LIST_ITEM_TYPES)).toBe(true);
    expect(LIST_ITEM_TYPES.filter(isListItemType)).toEqual([
      ...LIST_ITEM_TYPES,
    ]);
  });

  test.each([["taskx"], [""], [null], [undefined], [0], [[]]])(
    "rejects %p",
    (value) => {
      expect(isListItemType(value)).toBe(false);
    },
  );
});
