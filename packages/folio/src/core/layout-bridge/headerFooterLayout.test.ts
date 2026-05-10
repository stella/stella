import { describe, expect, test } from "bun:test";

import type { FlowBlock, Measure } from "../layout-engine/types";
import type { HeaderFooterMetrics } from "./headerFooterLayout";
import { calculateHeaderFooterVisualBounds } from "./headerFooterLayout";

const metrics: HeaderFooterMetrics = {
  section: "header",
  pageSize: { w: 600, h: 800 },
  margins: {
    top: 100,
    right: 72,
    bottom: 100,
    left: 72,
    header: 48,
    footer: 48,
  },
};

const tableMeasure = (totalHeight: number): Measure => ({
  kind: "table",
  rows: [],
  columnWidths: [],
  totalWidth: 120,
  totalHeight,
});

describe("calculateHeaderFooterVisualBounds", () => {
  test("accounts for page-anchored floating table bounds", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "table",
        id: "floating-table",
        rows: [],
        floating: {
          vertAnchor: "page",
          tblpYSpec: "bottom",
        },
      },
    ];

    const bounds = calculateHeaderFooterVisualBounds(
      blocks,
      [tableMeasure(50)],
      0,
      metrics,
    );

    expect(bounds).toEqual({ visualTop: 0, visualBottom: 752 });
  });

  test("defaults floating table bounds to the source cursor position", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "intro",
        runs: [{ kind: "text", text: "Intro" }],
      },
      {
        kind: "table",
        id: "floating-table",
        rows: [],
        floating: {},
      },
    ];

    const bounds = calculateHeaderFooterVisualBounds(
      blocks,
      [
        {
          kind: "paragraph",
          lines: [],
          totalHeight: 20,
        },
        tableMeasure(50),
      ],
      20,
      metrics,
    );

    expect(bounds).toEqual({ visualTop: 0, visualBottom: 70 });
  });
});
