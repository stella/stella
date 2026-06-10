import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearAllCaches } from "../layout-engine/measure";
import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import type {
  Layout,
  Measure,
  ParagraphBlock,
  TableBlock,
  TableMeasure,
} from "../layout-engine/types";
import { hitTestTableCell } from "./hitTest";
import { getCaretPosition, selectionToRects } from "./selectionRects";

const originalDocument = globalThis.document;

beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tagName: string) {
        if (tagName !== "canvas") {
          return {};
        }
        return {
          getContext() {
            return {
              font: "",
              measureText(text: string) {
                return { width: text.length * 7 };
              },
            };
          },
        };
      },
    },
  });
  clearAllCaches();
  resetCanvasContext();
});

afterEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  clearAllCaches();
  resetCanvasContext();
});

function clippedTableFixture(): {
  layout: Layout;
  block: TableBlock;
  measure: TableMeasure;
} {
  const block: TableBlock = {
    kind: "table",
    id: "table",
    rows: [
      {
        id: "row",
        cells: [
          {
            id: "cell",
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
            blocks: [
              {
                kind: "paragraph",
                id: "p",
                pmStart: 0,
                pmEnd: 6,
                runs: [{ kind: "text", text: "abcde" }],
              },
            ],
          },
        ],
      },
    ],
    columnWidths: [100],
  };
  const measure: TableMeasure = {
    kind: "table",
    rows: [
      {
        cells: [
          {
            blocks: [
              {
                kind: "paragraph",
                lines: Array.from({ length: 5 }, (_, index) => ({
                  fromRun: 0,
                  fromChar: index,
                  toRun: 0,
                  toChar: index + 1,
                  width: 10,
                  ascent: 16,
                  descent: 4,
                  lineHeight: 20,
                })),
                totalHeight: 100,
              },
            ],
            width: 100,
            height: 100,
          },
        ],
        height: 100,
      },
    ],
    columnWidths: [100],
    totalWidth: 100,
    totalHeight: 100,
  };
  const layout: Layout = {
    pageGap: 0,
    pages: [
      {
        number: 1,
        size: { w: 200, h: 200 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        fragments: [
          {
            kind: "table",
            blockId: "table",
            x: 0,
            y: 0,
            width: 100,
            height: 20,
            fromRow: 0,
            toRow: 1,
            topClip: 40,
            bottomClip: 60,
          },
        ],
      },
    ],
  };
  return { layout, block, measure };
}

function floatingClippedTableFixture(): {
  layout: Layout;
  block: TableBlock;
  measure: TableMeasure;
} {
  const block: TableBlock = {
    kind: "table",
    id: "floating-table",
    rows: [
      {
        id: "row",
        cells: [
          {
            id: "cell",
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
            blocks: [
              {
                kind: "paragraph",
                id: "p",
                pmStart: 0,
                pmEnd: 12,
                runs: [
                  {
                    kind: "image",
                    src: "float.png",
                    width: 168,
                    height: 80,
                    wrapType: "square",
                    cssFloat: "left",
                    displayMode: "float",
                  },
                  {
                    kind: "text",
                    text: "body text",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    columnWidths: [200],
  };
  const measure: TableMeasure = {
    kind: "table",
    rows: [
      {
        cells: [
          {
            blocks: [
              {
                kind: "paragraph",
                lines: [
                  {
                    fromRun: 1,
                    fromChar: 0,
                    toRun: 1,
                    toChar: 9,
                    width: 63,
                    ascent: 16,
                    descent: 4,
                    lineHeight: 20,
                  },
                ],
                totalHeight: 20,
              },
            ],
            width: 200,
            height: 120,
          },
        ],
        height: 120,
      },
    ],
    columnWidths: [200],
    totalWidth: 200,
    totalHeight: 120,
  };
  const layout: Layout = {
    pageGap: 0,
    pages: [
      {
        number: 1,
        size: { w: 240, h: 240 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        fragments: [
          {
            kind: "table",
            blockId: "floating-table",
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            fromRow: 0,
            toRow: 1,
            topClip: 80,
            bottomClip: 120,
          },
        ],
      },
    ],
  };
  return { layout, block, measure };
}

describe("selection rect geometry", () => {
  test("caret positions advance over atomic math runs", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      pmStart: 0,
      pmEnd: 5,
      runs: [
        {
          kind: "math",
          display: "inline",
          ommlXml: "<m:oMath />",
          plainText: "xx",
          fontFamily: "Cambria Math",
          fontSize: 11,
          pmStart: 1,
          pmEnd: 2,
        },
        {
          kind: "text",
          text: "abc",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 2,
          pmEnd: 5,
        },
      ],
    };
    const measures: Measure[] = [
      {
        kind: "paragraph",
        lines: [
          {
            fromRun: 0,
            toRun: 1,
            fromChar: 0,
            toChar: 3,
            width: 35,
            lineHeight: 16,
            ascent: 12,
            descent: 4,
          },
        ],
        width: 35,
        height: 16,
      },
    ];
    const layout: Layout = {
      pageGap: 0,
      pages: [
        {
          number: 1,
          size: { w: 600, h: 800 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          fragments: [
            {
              kind: "paragraph",
              blockId: "p1",
              x: 0,
              y: 0,
              width: 500,
              height: 16,
              fromLine: 0,
              toLine: 1,
            },
          ],
        },
      ],
    };

    const caret = getCaretPosition(layout, [block], measures, 2);

    expect(caret?.x).toBe(14);
  });

  test("caret Y includes float skip before the target line", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      pmStart: 0,
      pmEnd: 4,
      runs: [
        {
          kind: "text",
          text: "ab",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 1,
          pmEnd: 3,
        },
      ],
    };
    const measures: Measure[] = [
      {
        kind: "paragraph",
        lines: [
          {
            fromRun: 0,
            toRun: 0,
            fromChar: 0,
            toChar: 1,
            width: 7,
            lineHeight: 16,
            ascent: 12,
            descent: 4,
          },
          {
            fromRun: 0,
            toRun: 0,
            fromChar: 1,
            toChar: 2,
            width: 7,
            lineHeight: 16,
            ascent: 12,
            descent: 4,
            floatSkipBefore: 40,
          },
        ],
        totalHeight: 72,
      },
    ];
    const layout: Layout = {
      pageGap: 0,
      pages: [
        {
          number: 1,
          size: { w: 600, h: 800 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          fragments: [
            {
              kind: "paragraph",
              blockId: "p1",
              x: 0,
              y: 0,
              width: 500,
              height: 72,
              fromLine: 0,
              toLine: 2,
            },
          ],
        },
      ],
    };

    const caret = getCaretPosition(layout, [block], measures, 3);

    expect(caret?.y).toBe(56);
  });

  test("selection rects only include visible lines from clipped table rows", () => {
    const { layout, block, measure } = clippedTableFixture();

    const rects = selectionToRects(layout, [block], [measure], 1, 6);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.y).toBe(0);
    expect(rects[0]?.height).toBe(20);
  });

  test("selection rect clipping advances over nested cell blocks", () => {
    const block: TableBlock = {
      kind: "table",
      id: "table",
      rows: [
        {
          id: "row",
          cells: [
            {
              id: "cell",
              padding: { top: 0, right: 0, bottom: 0, left: 0 },
              blocks: [
                {
                  kind: "table",
                  id: "nested",
                  rows: [],
                  columnWidths: [80],
                },
                {
                  kind: "paragraph",
                  id: "p",
                  pmStart: 0,
                  pmEnd: 6,
                  runs: [{ kind: "text", text: "abcde" }],
                },
              ],
            },
          ],
        },
      ],
      columnWidths: [100],
    };
    const measure: TableMeasure = {
      kind: "table",
      rows: [
        {
          cells: [
            {
              blocks: [
                {
                  kind: "table",
                  rows: [],
                  columnWidths: [80],
                  totalWidth: 80,
                  totalHeight: 40,
                },
                {
                  kind: "paragraph",
                  lines: [
                    {
                      fromRun: 0,
                      fromChar: 0,
                      toRun: 0,
                      toChar: 1,
                      width: 10,
                      ascent: 16,
                      descent: 4,
                      lineHeight: 20,
                    },
                  ],
                  totalHeight: 20,
                },
              ],
              width: 100,
              height: 60,
            },
          ],
          height: 60,
        },
      ],
      columnWidths: [100],
      totalWidth: 100,
      totalHeight: 60,
    };
    const layout: Layout = {
      pageGap: 0,
      pages: [
        {
          number: 1,
          size: { w: 200, h: 200 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          fragments: [
            {
              kind: "table",
              blockId: "table",
              x: 0,
              y: 0,
              width: 100,
              height: 20,
              fromRow: 0,
              toRow: 1,
              topClip: 40,
              bottomClip: 60,
            },
          ],
        },
      ],
    };

    const rects = selectionToRects(layout, [block], [measure], 1, 2);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.y).toBe(0);
    expect(rects[0]?.height).toBe(20);
  });

  test("selection rects use rendered default table cell padding", () => {
    const { layout, block, measure } = clippedTableFixture();
    delete block.rows[0]!.cells[0]!.padding;
    const fragment = layout.pages[0]?.fragments[0];
    if (!fragment || fragment.kind !== "table") {
      throw new Error("expected table fragment");
    }
    fragment.height = 100;
    fragment.topClip = 0;
    fragment.bottomClip = 100;

    const rects = selectionToRects(layout, [block], [measure], 1, 2);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.x).toBe(7);
    expect(rects[0]?.y).toBe(1);
  });

  test("selection rect clipping accounts for cell top padding", () => {
    const { layout, block, measure } = clippedTableFixture();
    block.rows[0]!.cells[0]!.padding = {
      top: 40,
      right: 0,
      bottom: 0,
      left: 0,
    };

    const rects = selectionToRects(layout, [block], [measure], 1, 2);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.y).toBe(0);
    expect(rects[0]?.height).toBe(20);
  });

  test("selection rects use floating-aware clipped table line geometry", () => {
    const { layout, block, measure } = floatingClippedTableFixture();

    const rects = selectionToRects(layout, [block], [measure], 2, 10);

    expect(rects.length).toBeGreaterThan(0);
    expect(rects.every((rect) => rect.y >= 0 && rect.y < 40)).toBe(true);
  });

  test("table hit testing maps clipped continuations to row-local coordinates", () => {
    const { layout, block, measure } = clippedTableFixture();
    const page = layout.pages[0]!;

    const hit = hitTestTableCell(
      { pageIndex: 0, page, pageY: 10 },
      [block],
      [measure],
      { x: 5, y: 10 },
    );

    expect(hit?.cellLocalY).toBe(50);
  });
});

describe("template fill preview pm↔char mapping", () => {
  // A substituted value run keeps the source marker's PM range ([7, 22),
  // 15 positions) while carrying 4 characters of text, so caret/selection
  // geometry must map through each run's own PM bounds instead of assuming
  // one PM position per character.
  function previewFixture(): {
    layout: Layout;
    block: ParagraphBlock;
    measures: Measure[];
  } {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      pmStart: 0,
      pmEnd: 27,
      runs: [
        {
          kind: "text",
          text: "Name: ",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 1,
          pmEnd: 7,
        },
        {
          kind: "text",
          text: "1234",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 7,
          pmEnd: 22,
          templatePreview: "plain",
        },
        {
          kind: "text",
          text: " end",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 22,
          pmEnd: 26,
        },
      ],
    };
    const measures: Measure[] = [
      {
        kind: "paragraph",
        lines: [
          {
            fromRun: 0,
            toRun: 2,
            fromChar: 0,
            toChar: 4,
            width: 98,
            lineHeight: 16,
            ascent: 12,
            descent: 4,
          },
        ],
        width: 98,
        height: 16,
      },
    ];
    const layout: Layout = {
      pageGap: 0,
      pages: [
        {
          number: 1,
          size: { w: 600, h: 800 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          fragments: [
            {
              kind: "paragraph",
              blockId: "p1",
              x: 0,
              y: 0,
              width: 500,
              height: 16,
              fromLine: 0,
              toLine: 1,
            },
          ],
        },
      ],
    };
    return { layout, block, measures };
  }

  test("caret after the marker lands after the substituted value", () => {
    const { layout, block, measures } = previewFixture();

    // PM 22 is the first position after the marker; with the 4-char value
    // laid out, that's 10 chars * 7px — not the marker's 15-char width.
    const caret = getCaretPosition(layout, [block], measures, 22);

    expect(caret?.x).toBe(70);
  });

  test("caret inside the marker clamps to the value text", () => {
    const { layout, block, measures } = previewFixture();

    const atStart = getCaretPosition(layout, [block], measures, 7);
    const inside = getCaretPosition(layout, [block], measures, 9);
    const deepInside = getCaretPosition(layout, [block], measures, 20);

    expect(atStart?.x).toBe(42);
    expect(inside?.x).toBe(56);
    // Past the value's length: clamps to the end of the substituted text.
    expect(deepInside?.x).toBe(70);
  });

  test("caret at the end of the line maps past the trailing run", () => {
    const { layout, block, measures } = previewFixture();

    const caret = getCaretPosition(layout, [block], measures, 26);

    expect(caret?.x).toBe(98);
  });

  test("selecting the marker range highlights exactly the substituted value", () => {
    const { layout, block, measures } = previewFixture();

    const rects = selectionToRects(layout, [block], measures, 7, 22);

    expect(rects).toHaveLength(1);
    expect(rects[0]?.x).toBe(42);
    expect(rects[0]?.width).toBe(28);
  });
});
