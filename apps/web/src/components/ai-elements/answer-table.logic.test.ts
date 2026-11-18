import { expect, test } from "bun:test";
import type { Element, ElementContent } from "hast";

import { answerTableShape } from "@/components/ai-elements/answer-table.logic";

const element = (tagName: string, children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const row = (tag: "th" | "td", cells: string[]) =>
  element(
    "tr",
    cells.map((value) => element(tag, [{ type: "text", value }])),
  );

test("a header with no body rows has columns and no rows", () => {
  const table = element("table", [
    element("thead", [row("th", ["Clause", "Risk", "Change"])]),
  ]);
  expect(answerTableShape(table)).toEqual({ rows: 0, columns: 3 });
});

test("a table without a head counts its first row as the header", () => {
  const table = element("table", [
    element("tbody", [
      row("td", ["Month", "Hours"]),
      row("td", ["June", "12"]),
      row("td", ["July", "8"]),
    ]),
  ]);
  expect(answerTableShape(table)).toEqual({ rows: 2, columns: 2 });
});

test("columns follow the header even when a body row is ragged", () => {
  const table = element("table", [
    element("thead", [row("th", ["Party", "Role"])]),
    element("tbody", [row("td", ["Buyer"]), row("td", ["Seller", "x", "y"])]),
  ]);
  expect(answerTableShape(table)).toEqual({ rows: 2, columns: 2 });
});

test("anything but a parsed table has no shape", () => {
  expect(answerTableShape(undefined)).toBeNull();
  expect(answerTableShape(element("div", []))).toBeNull();
  expect(answerTableShape(element("table", []))).toBeNull();
});
