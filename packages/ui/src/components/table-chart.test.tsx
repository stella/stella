import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  TableChart,
  type TableChartKind,
  type TableChartPoint,
} from "./table-chart";

const render = (kind: TableChartKind, points: readonly TableChartPoint[]) =>
  renderToStaticMarkup(
    <TableChart
      kind={kind}
      points={points}
      title="Filed matters"
      summary="Civil matters account for 12 filings."
      xLabel="Category"
      yLabel="Filings"
      formatNumber={String}
    />,
  );

const points = [
  { label: "Civil", x: 1, y: 12 },
  { label: "Commercial", x: 2, y: -4 },
];

describe("table chart presentation", () => {
  test("renders every bar with its label, axes and an accessible summary", () => {
    const markup = render("bar", points);
    expect(markup.match(/data-slot="chart-bar"/gu)).toHaveLength(points.length);
    expect(markup).toContain("Civil: 12");
    expect(markup).toContain("Commercial: -4");
    expect(markup).toContain('data-slot="chart-axis"');
    expect(markup).toContain('data-slot="chart-zero"');
    expect(markup).toContain('role="img"');
    expect(markup).toMatch(/aria-labelledby="[^"]+-title"/u);
    expect(markup).toMatch(/aria-describedby="[^"]+-summary"/u);
    expect(markup).toContain("<figcaption");
    expect(markup).toContain("Civil matters account for 12 filings.");
    expect(markup).toContain("Category");
    expect(markup).toContain("Filings");
    const bars = [...markup.matchAll(/<rect[^>]*height="([^"]+)"/gu)];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(Number(bar[1])).toBeGreaterThan(0);
    }
  });

  test("groups connected lines by series while scatter remains unconnected", () => {
    const grouped = points.map((point, index) => ({
      ...point,
      series: index === 0 ? "Trial" : "Appeal",
    }));
    const line = render("line", grouped);
    expect(line.match(/data-slot="chart-line"/gu)).toHaveLength(2);
    expect(line.match(/data-slot="chart-point"/gu)).toHaveLength(2);
    expect(line).toContain('<bdi class="wrap-break-word">Trial</bdi>');
    const scatter = render("scatter", grouped);
    expect(scatter.match(/data-slot="chart-point"/gu)).toHaveLength(2);
    expect(scatter).not.toContain('data-slot="chart-line"');
  });

  test("renders full-circle and zero-total pies without degenerate arcs", () => {
    const full = render("pie", [{ label: "Civil", x: 0, y: 12 }]);
    expect(full).toMatch(/<circle[^>]*data-slot="chart-slice"/u);
    const zero = render("pie", [{ label: "Civil", x: 0, y: 0 }]);
    expect(zero).not.toContain('data-slot="chart-slice"');
    expect(zero).not.toMatch(/NaN|Infinity/u);
    const segmented = render("pie", [
      { label: "Civil", x: 0, y: 1 },
      { label: "Commercial", x: 1, y: 1 },
      { label: "Appeal", x: 2, y: 1 },
    ]);
    const slices = [
      ...segmented.matchAll(
        /<path[^>]*data-slot="chart-slice"[^>]*d="([^"]+)"/gu,
      ),
    ].map((match) => match[1]);
    expect(slices).toHaveLength(3);
    expect(new Set(slices).size).toBe(3);
    expect(segmented).not.toMatch(/NaN|Infinity/u);
  });

  test("category lines use source labels once per position and omit synthetic indices", () => {
    const markup = renderToStaticMarkup(
      <TableChart
        kind="line"
        xMode="category"
        title="Filings by period"
        summary="June has 12 filings."
        points={[
          { label: "June", x: 0, y: 12, series: "Trial" },
          { label: "July", x: 1, y: 8, series: "Trial" },
          { label: "June", x: 0, y: 3, series: "Appeal" },
          { label: "July", x: 1, y: 2, series: "Appeal" },
        ]}
        formatNumber={(value) => `formatted:${value}`}
      />,
    );
    const labels = [
      ...markup.matchAll(
        /<text[^>]*data-slot="chart-x-tick"[^>]*>([^<]+)<\/text>/gu,
      ),
    ].map((match) => match[1]);
    expect(labels).toEqual(["June", "July"]);
    expect(markup).toContain("June: formatted:12 (Trial)");
    expect(markup).toContain("July: formatted:2 (Appeal)");
    expect(markup).not.toContain("June: formatted:0,");
    expect(markup).not.toContain("July: formatted:1,");
  });

  test("keeps geometry finite for zero, constant and extreme domains in every cartesian kind", () => {
    const domains = [0, 9, -9, Number.MAX_VALUE, -Number.MAX_VALUE];
    for (const kind of ["bar", "line", "scatter"] as const) {
      for (const value of domains) {
        const markup = render(kind, [
          { label: "Civil", x: value, y: value },
          { label: "Commercial", x: -value, y: value },
        ]);
        expect(markup).not.toMatch(/NaN|Infinity/u);
      }
    }
  });

  test("uses caller number formatting, theme tokens and isolated text", () => {
    const markup = renderToStaticMarkup(
      <TableChart
        kind="scatter"
        points={points}
        title="القضايا"
        summary="١٢ قضية"
        formatNumber={(value) => `localized:${value}`}
      />,
    );
    expect(markup).toContain("localized:");
    expect(markup).toContain("var(--chart-1)");
    expect(markup).toContain("var(--border)");
    expect(markup).toContain("<bdi>١٢ قضية</bdi>");
    expect(markup).toContain('direction="ltr"');
  });

  test("rejects invalid renderer inputs rather than silently dropping values", () => {
    expect(() => render("bar", [])).toThrow(
      "Chart requires between 1 and 500 finite points",
    );
    expect(() =>
      render("scatter", [{ label: "Civil", x: Infinity, y: 1 }]),
    ).toThrow("Chart requires between 1 and 500 finite points");
    expect(() =>
      render(
        "bar",
        Array.from({ length: 501 }, () => ({ label: "Civil", x: 0, y: 1 })),
      ),
    ).toThrow("Chart requires between 1 and 500 finite points");
    expect(() => render("pie", points)).toThrow(
      "Pie chart values must be nonnegative",
    );
  });
});
