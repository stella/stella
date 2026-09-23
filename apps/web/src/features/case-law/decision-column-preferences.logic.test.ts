import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  DEFAULT_DECISION_TABLE_LAYOUT,
  StoredDecisionLayoutSchema,
  decisionTableLayouts,
  layoutForCountry,
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
      sizing: { summary: 420 },
      contentMode: "fit-content" as const,
      excerpt: "long" as const,
    };

    expect(layoutOf({ cz: layout })).toEqual(layout);
  });

  /**
   * The whole migration: a browser carrying an arrangement written before a
   * preference existed reads it back at that preference's default, rather than
   * as undefined. The schema is an object, so an unlisted key is also stripped
   * on the way in: forgetting either half loses the value silently.
   */
  test("an arrangement written before the excerpt length reads back at its default", () => {
    expect(
      layoutOf({
        cz: {
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
      { cz: { excerpt: "huge" } },
    ]) {
      expect(v.safeParse(StoredDecisionLayoutSchema, raw).success).toBe(false);
    }
  });
});
