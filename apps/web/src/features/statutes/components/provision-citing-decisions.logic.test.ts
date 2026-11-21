import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { orderCitingDecisions } from "./provision-citing-decisions.logic";

// A small id alphabet, so generated lists overlap the way a leading read and
// the full list do: the same decision arriving through both.
const decisionsArbitrary = fc.array(
  fc.constantFrom("a", "b", "c", "d", "e", "f").map((decisionId) => ({
    decisionId,
  })),
);

const idsOf = <T extends string>(rows: readonly { decisionId: T }[]) =>
  rows.map((row) => row.decisionId);

describe("orderCitingDecisions", () => {
  test("pinned leading decisions head one list, each decision once and marked", () => {
    const ordered = orderCitingDecisions({
      leading: [{ decisionId: "b" }, { decisionId: "d" }],
      pinLeading: true,
      rest: [{ decisionId: "a" }, { decisionId: "b" }, { decisionId: "c" }],
    });

    expect(
      ordered.map(({ decision, leading }) => [decision.decisionId, leading]),
    ).toEqual([
      ["b", true],
      ["d", true],
      ["a", false],
      ["c", false],
    ]);
  });

  test("a filtered list keeps its own rows and order, marking the leading ones", () => {
    const ordered = orderCitingDecisions({
      leading: [{ decisionId: "b" }, { decisionId: "d" }],
      pinLeading: false,
      rest: [{ decisionId: "c" }, { decisionId: "b" }],
    });

    expect(
      ordered.map(({ decision, leading }) => [decision.decisionId, leading]),
    ).toEqual([
      ["c", false],
      ["b", true],
    ]);
  });

  test("every decision is listed once, leading ones first and marked exactly when they lead", () => {
    assertProperty(
      "every decision is listed once, leading ones first and marked exactly when they lead",
      fc.property(
        decisionsArbitrary,
        decisionsArbitrary,
        fc.boolean(),
        (leading, rest, pinLeading) => {
          const ordered = orderCitingDecisions({ leading, pinLeading, rest });
          const ids = ordered.map(({ decision }) => decision.decisionId);
          const leadingIds = new Set(idsOf(leading));
          const expected = new Set([
            ...(pinLeading ? idsOf(leading) : []),
            ...idsOf(rest),
          ]);

          expect(new Set(ids).size).toBe(ids.length);
          expect(new Set(ids)).toEqual(expected);
          for (const row of ordered) {
            expect(row.leading).toBe(leadingIds.has(row.decision.decisionId));
          }
          if (pinLeading) {
            const firstOther = ordered.findIndex((row) => !row.leading);
            expect(
              firstOther === -1 ||
                ordered.slice(firstOther).every((row) => !row.leading),
            ).toBe(true);
          }
        },
      ),
    );
  });
});
