import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { filterCommandActions } from "@/components/search-dialog-actions.logic";

const actions = [
  { id: "title", title: "Create a matter", keywordLabels: ["workspace"] },
  { id: "keyword", title: "Open search", keywordLabels: ["Find a matter"] },
  { id: "other", title: "Open settings", keywordLabels: ["preferences"] },
];
const PROPERTY_TEXT_PARTS_MAX = 24;
const PROPERTY_KEYWORD_LABELS_MAX = 6;
const PROPERTY_ACTIONS_MAX = 16;

describe("search dialog command actions", () => {
  test("trims and case-folds one substring across titles or each keyword", () => {
    expect(
      filterCommandActions({ actions, mode: "browse", query: "  MATTER " }),
    ).toEqual([
      { id: "title", title: "Create a matter", keywordLabels: ["workspace"] },
      { id: "keyword", title: "Open search", keywordLabels: ["Find a matter"] },
    ]);
    expect(
      filterCommandActions({ actions, mode: "browse", query: "create a" }),
    ).toEqual([
      { id: "title", title: "Create a matter", keywordLabels: ["workspace"] },
    ]);
    expect(
      filterCommandActions({
        actions,
        mode: "browse",
        query: "matter workspace",
      }),
    ).toEqual([]);
  });

  test("returns all actions for a blank browse query and none in pick mode", () => {
    expect(
      filterCommandActions({ actions, mode: "browse", query: " \t " }),
    ).toEqual(actions);
    expect(filterCommandActions({ actions, mode: "pick", query: "" })).toEqual(
      [],
    );
    expect(
      filterCommandActions({ actions: [], mode: "browse", query: "" }),
    ).toEqual([]);
  });

  test("preserves order and returns more than a page-sized action set", () => {
    const manyActions = Array.from({ length: 60 }, (_, index) => ({
      id: `action-${index}`,
      title: `Action ${index}`,
      keywordLabels: ["batch"],
    }));
    expect(
      filterCommandActions({
        actions: manyActions,
        mode: "browse",
        query: "batch",
      }),
    ).toEqual(manyActions);
  });

  test("matches malformed titles and keywords through the replacement character", () => {
    const malformedActions = [
      { id: "title", title: "A\ud800ction", keywordLabels: [] },
      { id: "keyword", title: "Other", keywordLabels: ["A\ud800ction"] },
    ];

    expect(
      filterCommandActions({
        actions: malformedActions,
        mode: "browse",
        query: "\uFFFD",
      }),
    ).toEqual(malformedActions);
  });
});

test("search dialog actions preserve the previous title and keyword predicates", () => {
  const text = fc
    .array(
      fc.constantFrom(
        "a",
        "A",
        " ",
        "\t",
        "é",
        "e\u0301",
        "Ł",
        "İ",
        "ı",
        "ß",
        "[",
        ".",
        "😀",
        "\ud800",
        "ع",
      ),
      { maxLength: PROPERTY_TEXT_PARTS_MAX },
    )
    .map((parts) => parts.join(""));

  assertProperty(
    "search dialog actions preserve the previous title and keyword predicates",
    fc.property(
      fc.array(
        fc.record({
          title: text,
          keywordLabels: fc.array(text, {
            maxLength: PROPERTY_KEYWORD_LABELS_MAX,
          }),
        }),
        { maxLength: PROPERTY_ACTIONS_MAX },
      ),
      fc.constantFrom("browse" as const, "pick" as const),
      text,
      (generatedActions, mode, query) => {
        const needle = query.trim().toLowerCase().toWellFormed();
        const expected = generatedActions.filter(
          (action) =>
            mode === "browse" &&
            (needle.length === 0 ||
              action.title.toLowerCase().toWellFormed().includes(needle) ||
              action.keywordLabels.some((keyword) =>
                keyword.toLowerCase().toWellFormed().includes(needle),
              )),
        );

        expect(
          filterCommandActions({ actions: generatedActions, mode, query }),
        ).toEqual(expected);
      },
    ),
  );
});
