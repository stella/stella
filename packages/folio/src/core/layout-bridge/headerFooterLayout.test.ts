import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
  TableBlock,
} from "../layout-engine/types";
import type { HeaderFooter } from "../types/document";
import type { HeaderFooterMetrics } from "./headerFooterLayout";
import {
  calculateHeaderFooterVisualBounds,
  convertHeaderFooterToContent,
  normalizeHeaderFooterMeasureBlocks,
} from "./headerFooterLayout";

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

function paragraph(opts: Partial<ParagraphBlock> = {}): ParagraphBlock {
  return {
    kind: "paragraph",
    id: opts.id ?? "p",
    runs: opts.runs ?? [{ kind: "text", text: "Header" }],
    ...(opts.attrs ? { attrs: opts.attrs } : {}),
  };
}

function emptyParagraph(opts: Partial<ParagraphBlock> = {}): ParagraphBlock {
  return paragraph({ ...opts, runs: [] });
}

function table(blocks: FlowBlock[] = []): TableBlock {
  return {
    kind: "table",
    id: "table",
    rows: [
      {
        id: "row",
        cells: [
          {
            id: "cell",
            blocks,
          },
        ],
      },
    ],
  };
}

function measureBlocks(blocks: FlowBlock[]): Measure[] {
  return blocks.map((block) => {
    if (block.kind === "table") {
      return {
        kind: "table",
        rows: [],
        columnWidths: [120],
        totalWidth: 120,
        totalHeight: 24,
      };
    }

    return {
      kind: "paragraph",
      lines: [],
      totalHeight:
        block.kind === "paragraph" && block.attrs?.suppressEmptyParagraphHeight
          ? 0
          : 12,
    };
  });
}

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

describe("header/footer layout conversion", () => {
  test("routes header/footer tables through the body FlowBlock pipeline", () => {
    const header: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [
        {
          type: "table",
          rows: [
            {
              type: "tableRow",
              cells: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = convertHeaderFooterToContent(header, 600, metrics, {
      measureBlocks,
    });

    expect(result?.blocks[0]?.kind).toBe("table");
    expect(result?.height).toBe(24);
  });

  test("normalizes inherited spacing inside table-cell paragraphs", () => {
    const [normalized] = normalizeHeaderFooterMeasureBlocks([
      table([
        paragraph({
          id: "nested",
          attrs: {
            spacing: { before: 10, after: 8 },
            spacingExplicit: { before: true },
          },
        }),
      ]),
    ]) as [TableBlock];
    const nested = normalized.rows[0]?.cells[0]?.blocks[0] as ParagraphBlock;

    expect(nested.attrs?.spacing?.before).toBe(10);
    expect(nested.attrs?.spacing?.after).toBeUndefined();
  });

  test("suppresses only the canonical trailing empty paragraph after a final table", () => {
    const blocks = normalizeHeaderFooterMeasureBlocks([
      table(),
      emptyParagraph({ id: "middle" }),
      paragraph({ id: "body" }),
      table(),
      emptyParagraph({ id: "trailing" }),
    ]);

    expect(
      (blocks[1] as ParagraphBlock).attrs?.suppressEmptyParagraphHeight,
    ).toBeUndefined();
    expect(
      (blocks[4] as ParagraphBlock).attrs?.suppressEmptyParagraphHeight,
    ).toBe(true);
  });
});
