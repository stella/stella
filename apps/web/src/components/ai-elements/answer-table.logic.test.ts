import { expect, test } from "bun:test";
import type { Element, ElementContent } from "hast";

import {
  answerTableEdges,
  answerTableShape,
} from "@/components/ai-elements/answer-table.logic";

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

const box = {
  clientHeight: 300,
  clientWidth: 400,
  scrollHeight: 900,
  scrollLeft: 0,
  scrollTop: 0,
  scrollWidth: 1000,
};

test("a table at rest has more below and at its end only", () => {
  expect(answerTableEdges(box)).toEqual({
    above: false,
    below: true,
    start: false,
    end: true,
  });
});

test("a table scrolled to its far corner has more only above and at its start", () => {
  expect(answerTableEdges({ ...box, scrollLeft: 600, scrollTop: 600 })).toEqual(
    { above: true, below: false, start: true, end: false },
  );
});

test("a right-to-left table reads its negative offset from the start", () => {
  // Scrolling towards the inline end of a right-to-left box goes negative.
  expect(answerTableEdges({ ...box, scrollLeft: -600 })).toMatchObject({
    start: true,
    end: false,
  });
  expect(answerTableEdges({ ...box, scrollLeft: -200 })).toMatchObject({
    start: true,
    end: true,
  });
});

test("a table that fits shows no fades, whatever sub-pixel slack it has", () => {
  expect(
    answerTableEdges({
      ...box,
      scrollHeight: 300.5,
      scrollWidth: 400.5,
      scrollTop: 0.5,
      scrollLeft: 0.5,
    }),
  ).toEqual({ above: false, below: false, start: false, end: false });
});
