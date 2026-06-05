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

  test("selection rects only include visible lines from clipped table rows", () => {
    const { layout, block, measure } = clippedTableFixture();

    const rects = selectionToRects(layout, [block], [measure], 1, 6);

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
