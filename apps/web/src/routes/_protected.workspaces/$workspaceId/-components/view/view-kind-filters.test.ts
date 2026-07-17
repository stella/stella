import { describe, expect, test } from "bun:test";

import { includesListItems } from "./view-kind-filters";

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
