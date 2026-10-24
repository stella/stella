import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  isTableChartable,
  isTableChartPlanUsable,
  parseTableChartNumber,
  TABLE_CHART_LIMITS,
  tableChartPlanSchema,
  tableChartRequestSchema,
} from "./table-chart";
import type { TableChartPlan } from "./table-chart";

const table = {
  headers: ["Category", "Value"],
  rows: [
    ["A", "12"],
    ["B", "18"],
  ],
};
const plan = {
  kind: "bar",
  columns: [
    { index: 0, role: "label" },
    { index: 1, role: "y" },
  ],
  sort: "none",
  title: "Value",
} as const satisfies TableChartPlan;

// Keep mutable boundary arrays: the wire schemas produce mutable collections.
const validPlan = (): TableChartPlan => ({
  ...plan,
  columns: plan.columns.map((column) => ({ ...column })),
});

describe("table chart contract", () => {
  test("requires rectangular bounded tables", () => {
    expect(v.safeParse(tableChartRequestSchema, table).success).toBe(true);
    for (const input of [
      { ...table, rows: [["A"]] },
      { ...table, rows: [] },
      { ...table, headers: ["A"] },
      {
        ...table,
        rows: Array.from({ length: TABLE_CHART_LIMITS.rows + 1 }, () => [
          "A",
          "1",
        ]),
      },
      {
        ...table,
        rows: [["A", "1".repeat(TABLE_CHART_LIMITS.cellCharacters + 1)]],
      },
      {
        ...table,
        rows: Array.from({ length: 30 }, () => [
          "A".repeat(1000),
          "1".repeat(1000),
        ]),
      },
    ]) {
      expect(v.safeParse(tableChartRequestSchema, input).success).toBe(false);
    }
  });

  test("bounds multilingual headers and serialized table bytes", () => {
    const oversizedHeaders = {
      headers: Array.from({ length: TABLE_CHART_LIMITS.columns }, () =>
        "漢".repeat(2000),
      ),
      rows: [Array.from({ length: TABLE_CHART_LIMITS.columns }, () => "")],
    };
    expect(v.safeParse(tableChartRequestSchema, oversizedHeaders).success).toBe(
      false,
    );
    const escaped = {
      headers: ["Category", "Value"],
      rows: Array.from({ length: 10 }, () => ["\u0000".repeat(2000), "1"]),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(escaped)).byteLength,
    ).toBeGreaterThan(TABLE_CHART_LIMITS.tableBytes);
    expect(v.safeParse(tableChartRequestSchema, escaped).success).toBe(false);
  });

  test("rejects every invalid index and role combination", () => {
    expect(v.safeParse(tableChartPlanSchema, validPlan()).success).toBe(true);
    for (const index of [
      -1,
      0.5,
      2,
      TABLE_CHART_LIMITS.columns,
      Infinity,
      Number.NaN,
    ]) {
      expect(
        v.safeParse(tableChartPlanSchema, {
          ...validPlan(),
          columns: [
            { index, role: "label" },
            { index: 1, role: "y" },
          ],
        }).success,
      ).toBe(false);
    }
    for (const columns of [
      [
        { index: 0, role: "label" },
        { index: 0, role: "y" },
      ],
      [
        { index: 0, role: "x" },
        { index: 1, role: "label" },
      ],
      [
        { index: 0, role: "label" },
        { index: 1, role: "unknown" },
      ],
      [
        { index: 0, role: "ignore" },
        { index: 1, role: "y" },
      ],
    ]) {
      expect(
        v.safeParse(tableChartPlanSchema, { ...validPlan(), columns }).success,
      ).toBe(false);
    }
    expect(
      v.safeParse(tableChartPlanSchema, { ...validPlan(), kind: "radar" })
        .success,
    ).toBe(false);
  });

  test("a table is chartable only with a column whose every cell is numeric", () => {
    expect(isTableChartable(table)).toBe(true);
    expect(
      isTableChartable({
        headers: ["Situation", "Outcome"],
        rows: [
          ["Driving drunk", "Immediate termination"],
          ["Low level", "Notice"],
        ],
      }),
    ).toBe(false);
    expect(
      isTableChartable({ ...table, rows: [...table.rows, ["C", "n/a"]] }),
    ).toBe(false);
  });

  test("accepts only finite unambiguous numeric cells", () => {
    for (const value of ["0", "-12.5", "+12", ".25", "1e3", " 12 "]) {
      expect(parseTableChartNumber(value)).toBe(Number(value));
    }
    for (const value of [
      "",
      " ",
      "1,234",
      "1 234",
      "€12",
      "10%",
      "Infinity",
      "NaN",
      "0x10",
      "1e999",
    ]) {
      expect(parseTableChartNumber(value)).toBeNull();
      expect(
        isTableChartPlanUsable(validPlan(), { ...table, rows: [["A", value]] }),
      ).toBe(false);
    }
  });

  test("uses source series rows without aggregating and bounds chart points", () => {
    expect(
      isTableChartPlanUsable(
        {
          ...validPlan(),
          columns: [...validPlan().columns, { index: 2, role: "series" }],
        },
        {
          headers: ["Category", "Value", "Group"],
          rows: [
            ["A", "12", "First"],
            ["A", "18", "Second"],
          ],
        },
      ),
    ).toBe(true);
    const columns = [
      { index: 0, role: "label" },
      ...Array.from({ length: 3 }, (_value, index) => ({
        index: index + 1,
        role: "y",
      })),
    ];
    const parsed = v.parse(tableChartPlanSchema, { ...validPlan(), columns });
    expect(
      isTableChartPlanUsable(parsed, {
        headers: ["A", "B", "C", "D"],
        rows: Array.from({ length: 200 }, () => ["A", "1", "2", "3"]),
      }),
    ).toBe(false);
  });

  test("numeric horizontal roles require numeric cells for every chart kind", () => {
    for (const kind of ["bar", "line", "pie", "scatter"] as const) {
      const numericPlan = {
        ...validPlan(),
        kind,
        columns: [
          { index: 0, role: "x" },
          { index: 1, role: "y" },
        ],
      } as const satisfies TableChartPlan;
      expect(isTableChartPlanUsable(numericPlan, table)).toBe(false);
      expect(
        isTableChartPlanUsable(numericPlan, { ...table, rows: [["1", "12"]] }),
      ).toBe(true);
    }
  });

  test("scatter needs numeric horizontal coordinates and pie needs one positive whole", () => {
    expect(
      isTableChartPlanUsable({ ...validPlan(), kind: "scatter" }, table),
    ).toBe(false);
    const scatter = {
      ...validPlan(),
      kind: "scatter",
      columns: [
        { index: 0, role: "x" },
        { index: 1, role: "y" },
      ],
    } as const satisfies TableChartPlan;
    expect(
      isTableChartPlanUsable(scatter, { ...table, rows: [["1", "12"]] }),
    ).toBe(true);
    expect(isTableChartPlanUsable({ ...validPlan(), kind: "pie" }, table)).toBe(
      true,
    );
    for (const value of ["-1", "0"]) {
      expect(
        isTableChartPlanUsable(
          { ...validPlan(), kind: "pie" },
          { ...table, rows: [["A", value]] },
        ),
      ).toBe(false);
    }
  });
});
