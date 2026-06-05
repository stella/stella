import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
  TableBlock,
} from "../layout-engine/types";
import { headerFooterToProseDoc } from "../prosemirror/conversion/toProseDoc";
import { schema } from "../prosemirror/schema";
import type { HeaderFooter } from "../types/document";
import type { HeaderFooterMetrics } from "./headerFooterLayout";
import {
  calculateHeaderFooterMarginPushBounds,
  calculateHeaderFooterVisualBounds,
  convertHeaderFooterPmDocToContent,
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
    if (block.kind === "image") {
      return {
        kind: "image",
        width: block.width,
        height: block.height,
      };
    }
    if (block.kind === "textBox") {
      return {
        kind: "textBox",
        width: block.width,
        height: block.height ?? 12,
        innerMeasures: [],
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

  test("does not advance visual flow for floating text boxes before normal content", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "textBox",
        id: "letterhead",
        width: 560,
        height: 1100,
        displayMode: "float",
        content: [],
      },
      {
        kind: "paragraph",
        id: "title",
        runs: [{ kind: "text", text: "Header" }],
      },
    ];

    const bounds = calculateHeaderFooterVisualBounds(
      blocks,
      [
        { kind: "textBox", width: 560, height: 1100, innerMeasures: [] },
        { kind: "paragraph", lines: [], totalHeight: 12 },
      ],
      12,
      metrics,
    );

    expect(bounds).toEqual({ visualTop: 0, visualBottom: 1100 });
  });

  test("includes behindDoc images in visualBottom (render+hash signal)", () => {
    // Full-page letterhead: anchored to "margin", posOffset -1460500 EMU
    // (≈ -153px) places the image just above the body margin and its 1117px
    // height covers the whole page. `visualBottom` keeps tracking the
    // image so the renderer's option hash invalidates when the letterhead
    // changes.
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "letterhead",
        runs: [
          {
            kind: "image",
            src: "letterhead.png",
            width: 790,
            height: 1117,
            wrapType: "behind",
            position: {
              horizontal: { relativeTo: "margin", posOffset: -702_422 },
              vertical: { relativeTo: "margin", posOffset: -1_460_500 },
            },
          },
        ],
      },
    ];

    const bounds = calculateHeaderFooterVisualBounds(
      blocks,
      [{ kind: "paragraph", lines: [], totalHeight: 0 }],
      0,
      metrics,
    );

    // marginTop 100 + emuToPixels(-1_460_500) -153 - flowTop 48 = -101;
    // image bottom = top + 1117 = 1016.
    expect(bounds).toEqual({ visualTop: -101, visualBottom: 1016 });
  });
});

describe("calculateHeaderFooterMarginPushBounds", () => {
  test("excludes behindDoc image runs so the body margin doesn't reserve a full-page letterhead", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "letterhead",
        runs: [
          {
            kind: "image",
            src: "letterhead.png",
            width: 790,
            height: 1117,
            wrapType: "behind",
            position: {
              horizontal: { relativeTo: "margin", posOffset: -702_422 },
              vertical: { relativeTo: "margin", posOffset: -1_460_500 },
            },
          },
        ],
      },
    ];

    const bounds = calculateHeaderFooterMarginPushBounds(
      blocks,
      [{ kind: "paragraph", lines: [], totalHeight: 0 }],
      0,
      metrics,
    );

    expect(bounds).toEqual({ top: 0, bottom: 0 });
  });

  test("excludes behindDoc image blocks anchored at block level", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "image",
        id: "block-letterhead",
        src: "letterhead.png",
        width: 790,
        height: 1117,
        anchor: { isAnchored: true, behindDoc: true },
      },
    ];

    const bounds = calculateHeaderFooterMarginPushBounds(
      blocks,
      [{ kind: "image", width: 790, height: 1117 }],
      0,
      metrics,
    );

    expect(bounds).toEqual({ top: 0, bottom: 0 });
  });

  test("still counts flowing content (paragraph + in-flow image block)", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "title",
        runs: [{ kind: "text", text: "Header title" }],
      },
      {
        kind: "image",
        id: "inline-logo",
        src: "logo.png",
        width: 120,
        height: 40,
      },
    ];

    const bounds = calculateHeaderFooterMarginPushBounds(
      blocks,
      [
        { kind: "paragraph", lines: [], totalHeight: 12 },
        { kind: "image", width: 120, height: 40 },
      ],
      52,
      metrics,
    );

    expect(bounds).toEqual({ top: 0, bottom: 52 });
  });

  test("excludes a floating text-box letterhead from the body push but keeps it in the visual bounds (eigenpal #709)", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "title",
        runs: [{ kind: "text", text: "Header" }],
      },
      {
        kind: "textBox",
        id: "letterhead",
        width: 560,
        height: 1100,
        displayMode: "float",
        content: [],
      },
    ];
    const measures: Measure[] = [
      { kind: "paragraph", lines: [], totalHeight: 12 },
      { kind: "textBox", width: 560, height: 1100, innerMeasures: [] },
    ];

    // Simulate the pre-fix conversion path, where flowHeight was seeded with
    // paragraph + floating box height. Push still derives from in-flow blocks.
    expect(
      calculateHeaderFooterMarginPushBounds(blocks, measures, 1112, metrics),
    ).toEqual({ top: 0, bottom: 12 });
    // Visual: the letterhead is still part of the rendered extent.
    expect(
      calculateHeaderFooterVisualBounds(blocks, measures, 12, metrics)
        .visualBottom,
    ).toBeGreaterThanOrEqual(1100);
  });

  test("excludes a non-behindDoc anchored image block from the body push (eigenpal #709)", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "image",
        id: "anchored-logo",
        src: "logo.png",
        width: 560,
        height: 900,
        anchor: { isAnchored: true },
      },
    ];

    const bounds = calculateHeaderFooterMarginPushBounds(
      blocks,
      [{ kind: "image", width: 560, height: 900 }],
      900,
      metrics,
    );

    expect(bounds).toEqual({ top: 0, bottom: 0 });
  });

  test("excludes anchored (non-behindDoc) image runs from the body push (eigenpal #709)", () => {
    const blocks: FlowBlock[] = [
      {
        kind: "paragraph",
        id: "p",
        runs: [
          { kind: "text", text: "x" },
          {
            kind: "image",
            src: "logo.png",
            width: 560,
            height: 900,
            position: {
              horizontal: { relativeTo: "page", posOffset: 0 },
              vertical: { relativeTo: "page", posOffset: 0 },
            },
          },
        ],
      },
    ];

    // Simulate an inflated flowHeight from a paragraph measure plus anchored
    // image extent; only the paragraph's text height pushes.
    const bounds = calculateHeaderFooterMarginPushBounds(
      blocks,
      [{ kind: "paragraph", lines: [], totalHeight: 12 }],
      912,
      metrics,
    );

    expect(bounds).toEqual({ top: 0, bottom: 12 });
  });
});

describe("header/footer layout conversion", () => {
  test("derives flow height before margin push so floating text boxes do not seed the body push", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Header")]),
      schema.node(
        "textBox",
        {
          width: 560,
          height: 1100,
          displayMode: "float",
          wrapType: "behind",
        },
        [schema.node("paragraph", null, [])],
      ),
    ]);

    const result = convertHeaderFooterPmDocToContent(pmDoc, 600, metrics, {
      measureBlocks,
    });

    expect(result?.height).toBe(12);
    expect(result?.marginPushBottom).toBe(12);
    expect(result?.visualBottom).toBe(1112);
  });

  test("keeps topAndBottom text boxes in header/footer flow", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node(
        "textBox",
        {
          width: 560,
          height: 1100,
          displayMode: "block",
          wrapType: "topAndBottom",
        },
        [schema.node("paragraph", null, [])],
      ),
      schema.node("paragraph", null, [schema.text("Header")]),
    ]);

    const result = convertHeaderFooterPmDocToContent(pmDoc, 600, metrics, {
      measureBlocks,
    });

    expect(result?.height).toBe(1112);
    expect(result?.marginPushBottom).toBe(1112);
    expect(result?.visualBottom).toBe(1112);
  });

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

describe("convertHeaderFooterPmDocToContent", () => {
  // PM-doc source path used by the persistent hidden HF EditorView. Every
  // keystroke in the HF PM repaints via this function; the round-trip below
  // proves that "rebuild HeaderFooterContent from PM doc" produces the same
  // visible layout as "rebuild HeaderFooterContent from HeaderFooter.content",
  // so the switch from inline-overlay edit to PM-driven repaint is invisible.
  const pmMetrics: HeaderFooterMetrics = {
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

  test("returns undefined for a null pm doc", () => {
    expect(
      convertHeaderFooterPmDocToContent(null, 456, pmMetrics, {
        measureBlocks,
      }),
    ).toBeUndefined();
  });

  test("matches convertHeaderFooterToContent for paragraph + table fixture", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "run", content: [{ type: "text", text: "Header line" }] },
          ],
        },
        {
          type: "table",
          rows: [
            {
              type: "tableRow",
              cells: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "run",
                          content: [{ type: "text", text: "cell" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "paragraph", content: [] },
      ],
    };

    const fromContent = convertHeaderFooterToContent(hf, 456, pmMetrics, {
      measureBlocks,
    });
    const pmDoc = headerFooterToProseDoc(hf.content);
    const fromPmDoc = convertHeaderFooterPmDocToContent(pmDoc, 456, pmMetrics, {
      measureBlocks,
    });

    expect(fromPmDoc).toBeDefined();
    expect(fromContent).toBeDefined();
    expect(fromPmDoc?.height).toBe(fromContent!.height);
    expect(fromPmDoc?.visualTop).toBe(fromContent!.visualTop);
    expect(fromPmDoc?.visualBottom).toBe(fromContent!.visualBottom);
    expect(fromPmDoc?.blocks.length).toBe(fromContent!.blocks.length);
    expect(fromPmDoc?.measures.length).toBe(fromContent!.measures.length);
    expect(fromPmDoc?.blocks.map((b) => b.kind)).toEqual(
      fromContent!.blocks.map((b) => b.kind),
    );
  });

  test("applies PR #457 trailing-empty-after-table normalization on the PM-doc path", () => {
    const hf: HeaderFooter = {
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
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "run",
                          content: [{ type: "text", text: "in-cell" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "paragraph", content: [] },
      ],
    };
    const pmDoc = headerFooterToProseDoc(hf.content);
    const out = convertHeaderFooterPmDocToContent(pmDoc, 456, pmMetrics, {
      measureBlocks,
    });
    expect(out).toBeDefined();
    const trailing = out!.measures.at(-1);
    expect(trailing?.kind).toBe("paragraph");
    if (trailing?.kind === "paragraph") {
      expect(trailing.totalHeight).toBe(0);
    }
  });
});
