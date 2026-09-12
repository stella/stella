import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DEFAULT_DECISION_TABLE_LAYOUT,
  StoredDecisionLayoutSchema,
  decisionColumnOrder,
  decisionColumnPins,
  decisionTableLayout,
  withDecisionColumnMoved,
  withDecisionColumnPinned,
} from "./decision-column-preferences.logic";

const parse = (raw: unknown) => v.parse(StoredDecisionLayoutSchema, raw);

describe("what a stored arrangement means", () => {
  test("a jurisdiction nobody arranged gets the defaults", () => {
    expect(decisionTableLayout(undefined)).toEqual(
      DEFAULT_DECISION_TABLE_LAYOUT,
    );
  });

  test("a value written before order and pins existed is still its hidden set", () => {
    const stored = parse({ cz: ["headnote", "language"] });

    expect(decisionTableLayout(stored["cz"])).toEqual({
      ...DEFAULT_DECISION_TABLE_LAYOUT,
      hidden: ["headnote", "language"],
    });
  });

  test("a partial arrangement keeps the defaults for what it omits", () => {
    const stored = parse({ cz: { pinned: ["caseNumber"] } });

    expect(decisionTableLayout(stored["cz"])).toEqual({
      ...DEFAULT_DECISION_TABLE_LAYOUT,
      order: [],
      pinned: ["caseNumber"],
    });
  });

  test("an arrangement survives the round trip through storage", () => {
    const layout = {
      hidden: ["country"],
      order: ["summary", "caseNumber"],
      pinned: ["summary"],
      contentMode: "fit-content" as const,
    };

    expect(decisionTableLayout(parse({ cz: layout })["cz"])).toEqual(layout);
  });

  test("a stored value of the wrong shape is refused rather than half-read", () => {
    for (const raw of [
      { cz: { hidden: "summary" } },
      { cz: { contentMode: "huge" } },
    ]) {
      expect(v.safeParse(StoredDecisionLayoutSchema, raw).success).toBe(false);
    }
  });
});

describe("the order the columns are drawn in", () => {
  const available = ["caseNumber", "summary", "court", "date"];

  test("an unarranged table keeps the schema's order", () => {
    expect(decisionColumnOrder(available, [])).toEqual(available);
  });

  test("what the reader arranged comes first, the rest keeps its own order", () => {
    expect(decisionColumnOrder(available, ["date", "summary"])).toEqual([
      "date",
      "summary",
      "caseNumber",
      "court",
    ]);
  });

  test("a column the table no longer has cannot come back", () => {
    expect(decisionColumnOrder(available, ["gone", "date"])).toEqual([
      "date",
      "caseNumber",
      "summary",
      "court",
    ]);
  });

  test("every column is drawn exactly once, whatever was stored", () => {
    const ordered = decisionColumnOrder(available, [
      "date",
      "date",
      "gone",
      "summary",
    ]);

    expect(ordered.toSorted()).toEqual(available.toSorted());
  });

  test("only pins the table can honour survive", () => {
    expect(decisionColumnPins(available, ["gone", "date", "date"])).toEqual([
      "date",
    ]);
  });
});

describe("rearranging", () => {
  const order = ["a", "b", "c"];

  test("a column steps one place towards the front", () => {
    expect(withDecisionColumnMoved(order, "c", "earlier")).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  test("a column steps one place towards the back", () => {
    expect(withDecisionColumnMoved(order, "a", "later")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("a column at the end it is moving towards stays put", () => {
    expect(withDecisionColumnMoved(order, "a", "earlier")).toEqual(order);
    expect(withDecisionColumnMoved(order, "c", "later")).toEqual(order);
  });

  test("a column the order does not hold changes nothing", () => {
    expect(withDecisionColumnMoved(order, "z", "earlier")).toEqual(order);
  });

  test("moving never loses or duplicates a column", () => {
    for (const columnId of order) {
      for (const move of ["earlier", "later"] as const) {
        expect(
          withDecisionColumnMoved(order, columnId, move).toSorted(),
        ).toEqual(order.toSorted());
      }
    }
  });

  test("pinning is idempotent and unpinning undoes it", () => {
    const pinned = withDecisionColumnPinned([], "caseNumber", true);

    expect(withDecisionColumnPinned(pinned, "caseNumber", true)).toEqual([
      "caseNumber",
    ]);
    expect(withDecisionColumnPinned(pinned, "caseNumber", false)).toEqual([]);
  });
});
