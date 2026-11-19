import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  decisionTableLayouts,
  DEFAULT_DECISION_TABLE_LAYOUT,
  layoutForCountry,
  StoredDecisionLayoutSchema,
} from "./decision-column-preferences.logic";

const parse = (raw: unknown) => v.parse(StoredDecisionLayoutSchema, raw);

const layoutOf = (raw: unknown, country = "CZE") =>
  layoutForCountry(decisionTableLayouts(parse(raw)), country);

describe("what a stored arrangement means", () => {
  test("a jurisdiction nobody arranged gets the defaults", () => {
    expect(layoutForCountry({}, "CZE")).toEqual(DEFAULT_DECISION_TABLE_LAYOUT);
  });

  test("a partial arrangement keeps the defaults for what it omits", () => {
    expect(layoutOf({ CZE: { pinned: ["caseNumber"] } })).toEqual({
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
      sizing: { summary: 420 },
      contentMode: "fit-content" as const,
      excerpt: "long" as const,
    };

    expect(layoutOf({ CZE: layout })).toEqual(layout);
  });

  test("an omitted excerpt length reads back at its default", () => {
    expect(
      layoutOf({
        CZE: {
          hidden: ["country"],
          order: ["summary"],
          pinned: [],
          sizing: {},
          contentMode: "fit-content" as const,
        },
      }).excerpt,
    ).toBe(DEFAULT_DECISION_TABLE_LAYOUT.excerpt);
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
      parse({ CZE: { hidden: ["headnote"] }, POL: { pinned: ["caseNumber"] } }),
    );

    expect(layoutForCountry(layouts, "CZE")).toBe(
      layoutForCountry(layouts, "CZE"),
    );
    expect(layoutForCountry(layouts, "POL")).toBe(
      layoutForCountry(layouts, "POL"),
    );
  });

  test("a jurisdiction with no arrangement reads back as the one shared default", () => {
    const layouts = decisionTableLayouts(
      parse({ CZE: { hidden: ["headnote"] } }),
    );

    expect(layoutForCountry(layouts, "SVK")).toBe(
      DEFAULT_DECISION_TABLE_LAYOUT,
    );
    expect(layoutForCountry(null, "SVK")).toBe(DEFAULT_DECISION_TABLE_LAYOUT);
  });

  test("a stored value of the wrong shape is refused rather than half-read", () => {
    for (const raw of [
      { CZE: ["headnote"] },
      { unknown: { hidden: [] } },
      { CZE: { hidden: ["private text"] } },
      { CZE: { sizing: { summary: -1 } } },
      { CZE: { sizing: { summary: Number.POSITIVE_INFINITY } } },
      { CZE: { hidden: "summary" } },
      { CZE: { contentMode: "huge" } },
      { CZE: { excerpt: "huge" } },
    ]) {
      expect(v.safeParse(StoredDecisionLayoutSchema, raw).success).toBe(false);
    }
  });
});
