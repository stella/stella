import { describe, expect, test } from "bun:test";

import { includesListItems, viewEntityKinds } from "./view-kind-filters";

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
