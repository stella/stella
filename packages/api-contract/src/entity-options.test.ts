import { describe, expect, test } from "bun:test";

import {
  isEntityPriority,
  isListItemType,
  isTaskStatus,
} from "./entity-options";

describe("isTaskStatus", () => {
  test("accepts a canonical status", () => {
    expect(isTaskStatus("done")).toBe(true);
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
  test("accepts a canonical priority", () => {
    expect(isEntityPriority("urgent")).toBe(true);
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
  test("accepts a canonical list item type", () => {
    expect(isListItemType("task")).toBe(true);
  });

  test.each([["taskx"], [""], [null], [undefined], [0], [[]]])(
    "rejects %p",
    (value) => {
      expect(isListItemType(value)).toBe(false);
    },
  );
});
