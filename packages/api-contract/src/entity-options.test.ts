import { describe, expect, test } from "bun:test";

import {
  isEntityPriority,
  isListItemType,
  isTaskStatus,
  truncateEntityName,
} from "./entity-options";

describe("truncateEntityName", () => {
  test("does not split a surrogate pair at the length boundary", () => {
    expect(truncateEntityName(`${"a".repeat(254)}😀`)).toBe("a".repeat(254));
    expect(truncateEntityName(`${"a".repeat(253)}😀`)).toBe(
      `${"a".repeat(253)}😀`,
    );
  });

  test("replaces malformed input before truncating it", () => {
    expect(truncateEntityName(`${"a".repeat(254)}\uD83D`)).toBe(
      `${"a".repeat(254)}�`,
    );
  });
});

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
