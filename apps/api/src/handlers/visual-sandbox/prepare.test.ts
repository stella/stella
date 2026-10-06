import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";

import { prepareGeneratedVisual } from "./prepare";

const input = () =>
  v.parse(generatedVisualInputSchema, {
    title: "Revenue",
    html: '<div id="chart-revenue"></div>',
    data: { revenue: [{ month: "January", amount: 42 }] },
    charts: [
      {
        id: "chart-revenue",
        spec: {
          mark: "bar",
          dataset: "revenue",
          x: { field: "month", type: "nominal", scale: "band" },
          y: { field: "amount", type: "quantitative", scale: "linear" },
          height: 360,
        },
      },
    ],
  });

describe("generated visual preparation", () => {
  test("retains data referenced by the chart contract", () => {
    const source = input();
    const prepared = prepareGeneratedVisual(source);
    expect(prepared.isOk()).toBe(true);
    if (prepared.isOk()) {
      expect(prepared.value.data).toEqual(source.data);
    }
  });
  test("refuses unused fields and permits literal page references", () => {
    const source = input();
    source.data["revenue"] = [
      { month: "January", amount: 42, note: "First month" },
    ];
    const unused = prepareGeneratedVisual(source);
    expect(unused.isErr()).toBe(true);
    if (unused.isErr()) {
      expect(unused.error.message).toContain("revenue.note");
    }
    source.html += "<p>note: First month</p>";
    expect(prepareGeneratedVisual(source).isOk()).toBe(true);
  });
  test("refuses missing or duplicate chart containers and incompatible rows", () => {
    const source = input();
    expect(
      prepareGeneratedVisual({ ...source, html: "<p>Revenue</p>" }).isErr(),
    ).toBe(true);
    expect(
      prepareGeneratedVisual({
        ...source,
        html: source.html + source.html,
      }).isErr(),
    ).toBe(true);
    expect(
      prepareGeneratedVisual({
        ...source,
        charts: [...source.charts, ...source.charts],
      }).isErr(),
    ).toBe(true);
    expect(
      prepareGeneratedVisual({
        ...source,
        data: { revenue: [{ month: "January", amount: "42" }] },
      }).isErr(),
    ).toBe(true);
  });
});
