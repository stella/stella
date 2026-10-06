import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  generatedVisualInputSchema,
  visualChartSpecSchema,
} from "./generated-visual";

const chart = {
  mark: "bar",
  dataset: "revenue",
  x: { field: "month", type: "nominal", scale: "band" },
  y: { field: "amount", type: "quantitative", scale: "linear" },
  height: 360,
} as const;

describe("generated visual contract", () => {
  test("preserves a typed chart and finite JSON data", () => {
    const input = {
      title: " Revenue ",
      html: '<div id="chart-revenue"></div>',
      data: { revenue: [{ month: "January", amount: 42 }] },
      charts: [{ id: "chart-revenue", spec: chart }],
    };
    const parsed = v.parse(generatedVisualInputSchema, input);
    expect(parsed.title).toBe("Revenue");
    expect(parsed.charts.at(0)?.spec).toEqual(chart);
    expect(parsed.data).toEqual(input.data);
  });

  test("rejects incompatible channel scales and unknown chart options", () => {
    expect(
      v.safeParse(visualChartSpecSchema, {
        ...chart,
        x: { field: "month", type: "nominal", scale: "linear" },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(visualChartSpecSchema, { ...chart, renderer: "custom" })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(visualChartSpecSchema, {
        ...chart,
        y: { field: "amount", type: "temporal", scale: "time" },
      }).success,
    ).toBe(false);
  });

  test("bounds JSON values, nesting, node count and encoded bytes", () => {
    const input = { title: "Table", html: "<p>Values</p>", charts: [] };
    for (const data of [
      { value: Number.NaN },
      { value: Infinity },
      { value: undefined },
      { value: new Date() },
      { value: "é".repeat(524_288) },
      { value: Array.from({ length: 50_001 }, () => 0) },
    ]) {
      expect(
        v.safeParse(generatedVisualInputSchema, { ...input, data }).success,
      ).toBe(false);
    }
    let nested: unknown = 0;
    for (let depth = 0; depth < 33; depth += 1) {
      nested = [nested];
    }
    expect(
      v.safeParse(generatedVisualInputSchema, {
        ...input,
        data: { value: nested },
      }).success,
    ).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle["value"] = cycle;
    expect(
      v.safeParse(generatedVisualInputSchema, { ...input, data: cycle })
        .success,
    ).toBe(false);
  });
});
