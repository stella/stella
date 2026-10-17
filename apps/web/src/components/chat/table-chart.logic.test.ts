import { expect, test } from "bun:test";
import type { Element } from "hast";

import type {
  TableChartPlan,
  TableChartRequest,
} from "@stll/api-contract/table-chart";

import { chartTableFromNode, tableChartPoints } from "./table-chart.logic";

const table = {
  headers: ["Month", "Hours"],
  rows: [
    ["July", "12"],
    ["June", "-2"],
  ],
} satisfies TableChartRequest;
const plan = {
  kind: "bar",
  columns: [
    { index: 0, role: "label" },
    { index: 1, role: "y" },
  ],
  sort: "ascending",
  title: "Hours",
} satisfies TableChartPlan;

test("category sorting preserves each source label and signed value", () => {
  const points = tableChartPoints({ table, plan, locale: "en" });
  expect(points).toEqual([
    { label: "July", x: 0, y: 12 },
    { label: "June", x: 1, y: -2 },
  ]);
  expect(
    tableChartPoints({
      table,
      plan: { ...plan, sort: "descending" },
      locale: "en",
    }).map(({ label }) => label),
  ).toEqual(["June", "July"]);
  expect(table.rows).toEqual([
    ["July", "12"],
    ["June", "-2"],
  ]);
});

test("numeric order keeps each series paired with its source coordinate", () => {
  const numeric = {
    headers: ["Year", "Hours", "Team"],
    rows: [
      ["10", "12", "A"],
      ["2", "-2", "B"],
    ],
  } satisfies TableChartRequest;
  const numericPlan = {
    kind: "scatter",
    columns: [
      { index: 0, role: "x" },
      { index: 1, role: "y" },
      { index: 2, role: "series" },
    ],
    sort: "ascending",
    title: "Hours",
  } satisfies TableChartPlan;
  expect(
    tableChartPoints({ table: numeric, plan: numericPlan, locale: "en" }),
  ).toEqual([
    { label: "2", x: 2, y: -2, series: "B" },
    { label: "10", x: 10, y: 12, series: "A" },
  ]);
});

test("series share the same coordinate for the same category without aggregating source rows", () => {
  const grouped = {
    headers: ["Month", "Hours", "Team"],
    rows: [
      ["June", "12", "A"],
      ["June", "8", "B"],
      ["July", "20", "A"],
      ["July", "15", "B"],
    ],
  } satisfies TableChartRequest;
  const groupedPlan = {
    kind: "line",
    columns: [
      { index: 0, role: "label" },
      { index: 1, role: "y" },
      { index: 2, role: "series" },
    ],
    sort: "none",
    title: "Hours",
  } satisfies TableChartPlan;
  expect(
    tableChartPoints({ table: grouped, plan: groupedPlan, locale: "en" }),
  ).toEqual([
    { label: "June", x: 0, y: 12, series: "A" },
    { label: "June", x: 0, y: 8, series: "B" },
    { label: "July", x: 1, y: 20, series: "A" },
    { label: "July", x: 1, y: 15, series: "B" },
  ]);
});

test("ambiguous source magnitudes never become chart values", () => {
  for (const value of ["1,000", "1,25", "€20", "", "Infinity"]) {
    expect(
      tableChartPoints({
        table: { ...table, rows: [["June", value]] },
        plan,
        locale: "en",
      }),
    ).toEqual([]);
  }
});

test("parsed inline markup contributes text rather than markdown syntax", () => {
  const cell = (text: string): Element => ({
    type: "element",
    tagName: "td",
    properties: {},
    children: [{ type: "text", value: text }],
  });
  const node = {
    type: "element",
    tagName: "table",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "thead",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "tr",
            properties: {},
            children: [cell("Month"), cell("Hours")],
          },
        ],
      },
      {
        type: "element",
        tagName: "tbody",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "tr",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "td",
                properties: {},
                children: [
                  {
                    type: "element",
                    tagName: "strong",
                    properties: {},
                    children: [{ type: "text", value: "June" }],
                  },
                ],
              },
              cell("12"),
            ],
          },
        ],
      },
    ],
  } satisfies Element;
  expect(chartTableFromNode(node)).toEqual({
    headers: ["Month", "Hours"],
    rows: [["June", "12"]],
  });
  expect(chartTableFromNode(undefined)).toBeNull();
});
