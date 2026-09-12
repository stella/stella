import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DEFAULT_DECISION_TABLE_LAYOUT,
  StoredDecisionLayoutSchema,
  decisionColumnOrder,
  decisionColumnPins,
  decisionTableLayouts,
  layoutForCountry,
  withDecisionColumnMoved,
  withDecisionColumnPinned,
} from "./decision-column-preferences.logic";

const parse = (raw: unknown) => v.parse(StoredDecisionLayoutSchema, raw);

const layoutOf = (raw: unknown, country = "cz") =>
  layoutForCountry(decisionTableLayouts(parse(raw)), country);

describe("what a stored arrangement means", () => {
  test("a jurisdiction nobody arranged gets the defaults", () => {
    expect(layoutForCountry({}, "cz")).toEqual(DEFAULT_DECISION_TABLE_LAYOUT);
  });

  test("a value written before order and pins existed is still its hidden set", () => {
    expect(layoutOf({ cz: ["headnote", "language"] })).toEqual({
      ...DEFAULT_DECISION_TABLE_LAYOUT,
      hidden: ["headnote", "language"],
    });
  });

  test("a partial arrangement keeps the defaults for what it omits", () => {
    expect(layoutOf({ cz: { pinned: ["caseNumber"] } })).toEqual({
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

    expect(layoutOf({ cz: layout })).toEqual(layout);
  });

  /**
   * The table's arrangement is handed to TanStack as controlled state, which
   * it compares by identity and publishes back whenever it differs. A layout
   * rebuilt while rendering is a different object every time, so the table
   * publishes state nobody changed, the publish re-renders, and the render
   * rebuilds it: the page pegs the main thread with no error anywhere. The
   * arrangement is therefore normalised once, when storage is read.
   */
  test("the same jurisdiction reads back as the same object, not a fresh one", () => {
    const layouts = decisionTableLayouts(
      parse({ cz: ["headnote"], pl: { pinned: ["caseNumber"] } }),
    );

    expect(layoutForCountry(layouts, "cz")).toBe(
      layoutForCountry(layouts, "cz"),
    );
    expect(layoutForCountry(layouts, "pl")).toBe(
      layoutForCountry(layouts, "pl"),
    );
  });

  test("a jurisdiction with no arrangement reads back as the one shared default", () => {
    const layouts = decisionTableLayouts(parse({ cz: ["headnote"] }));

    expect(layoutForCountry(layouts, "sk")).toBe(DEFAULT_DECISION_TABLE_LAYOUT);
    expect(layoutForCountry(null, "sk")).toBe(DEFAULT_DECISION_TABLE_LAYOUT);
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
