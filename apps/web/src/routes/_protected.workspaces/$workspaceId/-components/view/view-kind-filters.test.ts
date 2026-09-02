import { describe, expect, test } from "bun:test";

import {
  admitsOnlyTaskKind,
  includesListItems,
  viewEntityKinds,
} from "./view-kind-filters";

describe("view entity kinds", () => {
  test("reads the kinds a view admits, nested groups included", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task", "message"],
            },
          ],
        },
      ]),
    ).toEqual(["task", "message"]);
  });

  test("is null for a view that does not restrict the kind", () => {
    expect(viewEntityKinds([])).toBeNull();
    expect(
      viewEntityKinds([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "is_not_empty",
        },
      ]),
    ).toBeNull();
  });

  test("ignores values that are not entity kinds", () => {
    expect(
      viewEntityKinds([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task", "spreadsheet"],
        },
      ]),
    ).toEqual(["task"]);
  });

  test("is null for an or group with one non-kind child", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
            {
              type: "predicate",
              operand: { type: "property", propertyId: "status" },
              op: "is_not_empty",
            },
          ],
        },
      ]),
    ).toBeNull();
  });

  test("unions the kinds an or group's children each admit", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["message"],
            },
          ],
        },
      ]),
    ).toEqual(["task", "message"]);
  });

  test("is null for a negated group", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "and",
          negated: true,
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
          ],
        },
      ]),
    ).toBeNull();
  });

  test("intersects the kinds an and group's predicates each admit", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task", "message"],
            },
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["message", "document"],
            },
          ],
        },
      ]),
    ).toEqual(["message"]);
  });

  test("ignores an unrelated predicate anded with a kind filter", () => {
    expect(
      viewEntityKinds([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
        {
          type: "predicate",
          operand: { type: "property", propertyId: "status" },
          op: "is_not_empty",
        },
      ]),
    ).toEqual(["task"]);
  });
  test("an empty or group leaves the view unrestricted", () => {
    expect(
      viewEntityKinds([{ type: "group", combinator: "or", children: [] }]),
    ).toBeNull();
    expect(
      viewEntityKinds([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
        { type: "group", combinator: "or", children: [] },
      ]),
    ).toEqual(["task"]);
  });

  test("a dropped group inside an or does not widen its siblings", () => {
    // The query compiler discards the empty group and keeps the task
    // restriction, so the view can only return tasks.
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
            { type: "group", combinator: "or", children: [] },
          ],
        },
      ]),
    ).toEqual(["task"]);
  });

  // A compare that the SQL compiler drops as incomplete (an ordered op
  // against an empty literal — the operator is chosen, the value has not
  // been entered yet) must be dropped here too, not treated as an
  // unrestricted sibling: SQL only ever restricts to the surviving `kind in
  // […]` branch, matching `entity-filters.ts`'s `compileCompare`.
  test("an incomplete compare inside an or does not widen a sibling kind restriction", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
            {
              type: "compare",
              left: { type: "property", propertyId: "due-date" },
              op: "lt",
              right: { type: "literal", value: "" },
            },
          ],
        },
      ]),
    ).toEqual(["task"]);
  });

  // The complement: a genuinely complete, unrelated compare DOES compile to
  // SQL, so it keeps the `or` group unrestricted, exactly as it would keep
  // a real WHERE clause from restricting to `kind`.
  test("a complete unrelated compare inside an or leaves the view unrestricted", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "or",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
            {
              type: "compare",
              left: { type: "property", propertyId: "due-date" },
              op: "lt",
              right: { type: "literal", value: "2026-01-01" },
            },
          ],
        },
      ]),
    ).toBeNull();
  });

  test("a group whose children are all dropped is dropped itself", () => {
    expect(
      viewEntityKinds([
        {
          type: "group",
          combinator: "and",
          children: [
            { type: "group", combinator: "or", children: [] },
            { type: "group", combinator: "and", negated: true, children: [] },
          ],
        },
      ]),
    ).toBeNull();
    expect(
      viewEntityKinds([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["message"],
        },
        {
          type: "group",
          combinator: "or",
          children: [{ type: "group", combinator: "or", children: [] }],
        },
      ]),
    ).toEqual(["message"]);
  });
});

describe("admitsOnlyTaskKind", () => {
  test("true for a view restricted to task alone", () => {
    expect(
      admitsOnlyTaskKind([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
      ]),
    ).toBe(true);
  });

  test("false for a view admitting several kinds", () => {
    expect(
      admitsOnlyTaskKind([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task", "message"],
        },
      ]),
    ).toBe(false);
  });

  test("false for an unrestricted view", () => {
    expect(admitsOnlyTaskKind([])).toBe(false);
  });

  test("false for a view restricted to a non-task kind alone", () => {
    expect(
      admitsOnlyTaskKind([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["document"],
        },
      ]),
    ).toBe(false);
  });
});

describe("List view detection", () => {
  test("recognizes an explicit task kind filter", () => {
    expect(
      includesListItems([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
      ]),
    ).toBe(true);
  });

  test("does not treat document views as Lists", () => {
    expect(
      includesListItems([
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["document"],
        },
      ]),
    ).toBe(false);
  });
});
