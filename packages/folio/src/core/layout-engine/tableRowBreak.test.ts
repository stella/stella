/**
 * Table row-break geometry + mid-content row splitting. A table row taller than
 * a whole page must break between whole text lines across pages instead of
 * overflowing and clipping content. Regression for eigenpal/docx-editor#698
 * (their #570).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import { clearAllCaches, resetCanvasContext } from "./measure";
import { buildTableRowBreakInfo, snapRowBreak } from "./tableRowBreak";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  MeasuredLine,
  ParagraphMeasure,
  TableBlock,
  TableFragment,
  TableMeasure,
} from "./types";

const LINE = 20;
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

function linesWithHeight(n: number, lineHeight: number): MeasuredLine[] {
  return Array.from({ length: n }, () => ({
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 1,
    width: 10,
    ascent: lineHeight - 4,
    descent: 4,
    lineHeight,
  }));
}

function paraMeasureWithLineHeight(
  n: number,
  lineHeight: number,
): ParagraphMeasure {
  return {
    kind: "paragraph",
    lines: linesWithHeight(n, lineHeight),
    totalHeight: n * lineHeight,
  };
}

function paraMeasure(n: number): ParagraphMeasure {
  return paraMeasureWithLineHeight(n, LINE);
}

/** A single-cell, single-paragraph table whose one row is `n` lines tall. */
function tallTable(n: number): { block: TableBlock; measure: TableMeasure } {
  const height = n * LINE;
  const block: TableBlock = {
    kind: "table",
    id: "t",
    rows: [
      {
        id: "r0",
        cells: [
          {
            id: "c0",
            blocks: [
              {
                kind: "paragraph",
                id: "p",
                runs: [{ kind: "text", text: "x" }],
              },
            ],
          },
        ],
      },
    ],
    columnWidths: [220],
  };
  const measure: TableMeasure = {
    kind: "table",
    rows: [
      { cells: [{ blocks: [paraMeasure(n)], width: 220, height }], height },
    ],
    columnWidths: [220],
    totalWidth: 220,
    totalHeight: height,
  };
  return { block, measure };
}

function tableWithHeaderAndTallBody(bodyLines: number): {
  block: TableBlock;
  measure: TableMeasure;
} {
  const headerHeight = LINE;
  const bodyHeight = bodyLines * LINE;
  const block: TableBlock = {
    kind: "table",
    id: "t",
    rows: [
      {
        id: "r-header",
        isHeader: true,
        cells: [
          {
            id: "c-header",
            blocks: [
              {
                kind: "paragraph",
                id: "p-header",
                runs: [{ kind: "text", text: "header" }],
              },
            ],
          },
        ],
      },
      {
        id: "r-body",
        cells: [
          {
            id: "c-body",
            blocks: [
              {
                kind: "paragraph",
                id: "p-body",
                runs: [{ kind: "text", text: "body" }],
              },
            ],
          },
        ],
      },
    ],
    columnWidths: [220],
  };
  const measure: TableMeasure = {
    kind: "table",
    rows: [
      {
        cells: [
          {
            blocks: [paraMeasure(1)],
            width: 220,
            height: headerHeight,
          },
        ],
        height: headerHeight,
      },
      {
        cells: [
          {
            blocks: [paraMeasure(bodyLines)],
            width: 220,
            height: bodyHeight,
          },
        ],
        height: bodyHeight,
      },
    ],
    columnWidths: [220],
    totalWidth: 220,
    totalHeight: headerHeight + bodyHeight,
  };
  return { block, measure };
}

describe("buildTableRowBreakInfo / snapRowBreak", () => {
  test("collects line-bottom offsets per row plus the row boundary", () => {
    const { block, measure } = tallTable(3);
    const info = buildTableRowBreakInfo(block, measure);
    expect(info.rowTops).toEqual([0, 3 * LINE]);
    expect(info.breakOffsets[0]).toEqual([LINE, 2 * LINE, 3 * LINE]);
  });

  test("treats height-based cell blocks as atomic break offsets", () => {
    const block: TableBlock = {
      kind: "table",
      id: "t",
      rows: [
        {
          id: "r0",
          cells: [
            {
              id: "c0",
              padding: { top: 5, right: 0, bottom: 0, left: 0 },
              blocks: [
                {
                  kind: "image",
                  id: "img",
                  src: "image.png",
                  width: 20,
                  height: 30,
                },
                {
                  kind: "textBox",
                  id: "tb",
                  width: 80,
                  height: 50,
                  content: [],
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
                { kind: "image", width: 20, height: 30 },
                { kind: "textBox", width: 80, height: 50, innerMeasures: [] },
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

    const info = buildTableRowBreakInfo(block, measure);

    expect(info.breakOffsets[0]).toEqual([35, 85, 100]);
  });

  test("keeps only row break offsets that are safe for every cell", () => {
    const block: TableBlock = {
      kind: "table",
      id: "t",
      rows: [
        {
          id: "r0",
          cells: [
            {
              id: "c0",
              blocks: [
                {
                  kind: "paragraph",
                  id: "p0",
                  runs: [{ kind: "text", text: "a" }],
                },
              ],
            },
            {
              id: "c1",
              blocks: [
                {
                  kind: "paragraph",
                  id: "p1",
                  runs: [{ kind: "text", text: "b" }],
                },
              ],
            },
          ],
        },
      ],
      columnWidths: [100, 100],
    };
    const measure: TableMeasure = {
      kind: "table",
      rows: [
        {
          cells: [
            {
              blocks: [paraMeasureWithLineHeight(3, 20)],
              width: 100,
              height: 60,
            },
            {
              blocks: [paraMeasureWithLineHeight(4, 15)],
              width: 100,
              height: 60,
            },
          ],
          height: 60,
        },
      ],
      columnWidths: [100, 100],
      totalWidth: 200,
      totalHeight: 60,
    };

    const info = buildTableRowBreakInfo(block, measure);

    expect(info.breakOffsets[0]).toEqual([60]);
  });

  test("uses floating-aware paragraph measures for row split offsets", () => {
    const block: TableBlock = {
      kind: "table",
      id: "t",
      rows: [
        {
          id: "r0",
          cells: [
            {
              id: "c0",
              padding: { top: 0, right: 0, bottom: 0, left: 0 },
              blocks: [
                {
                  kind: "paragraph",
                  id: "p0",
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
              blocks: [paraMeasure(6)],
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

    const info = buildTableRowBreakInfo(block, measure);
    const firstSlice = snapRowBreak(info, 0, 0, 60);
    const floatedLineSlice = snapRowBreak(info, 0, 0, 110);

    expect(info.breakOffsets[0]).not.toContain(LINE);
    expect(firstSlice).toBe(0);
    expect(floatedLineSlice).toBeGreaterThanOrEqual(80);
    expect(floatedLineSlice).toBeLessThan(120);
  });

  test("shifts unsafe ranges for vertically aligned cells", () => {
    const block: TableBlock = {
      kind: "table",
      id: "t",
      rows: [
        {
          id: "r0",
          cells: [
            {
              id: "c0",
              blocks: [
                {
                  kind: "paragraph",
                  id: "p0",
                  runs: [{ kind: "text", text: "a" }],
                },
              ],
            },
            {
              id: "c1",
              verticalAlign: "bottom",
              blocks: [
                {
                  kind: "paragraph",
                  id: "p1",
                  runs: [{ kind: "text", text: "b" }],
                },
              ],
            },
          ],
        },
      ],
      columnWidths: [100, 100],
    };
    const measure: TableMeasure = {
      kind: "table",
      rows: [
        {
          cells: [
            {
              blocks: [paraMeasureWithLineHeight(10, 10)],
              width: 100,
              height: 100,
            },
            {
              blocks: [paraMeasureWithLineHeight(1, 20)],
              width: 100,
              height: 20,
            },
          ],
          height: 100,
        },
      ],
      columnWidths: [100, 100],
      totalWidth: 200,
      totalHeight: 100,
    };

    const info = buildTableRowBreakInfo(block, measure);

    expect(info.breakOffsets[0]).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 100]);
  });

  test("uses floating-aware paragraph lines for safe split offsets", () => {
    const block: TableBlock = {
      kind: "table",
      id: "t",
      rows: [
        {
          id: "r0",
          cells: [
            {
              id: "c0",
              blocks: [
                {
                  kind: "paragraph",
                  id: "p0",
                  runs: [
                    {
                      kind: "image",
                      src: "float.png",
                      width: 70,
                      height: 80,
                      wrapType: "square",
                      cssFloat: "left",
                    },
                    {
                      kind: "text",
                      text: "floating images should reduce the line width while they overlap text",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      columnWidths: [114],
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
                  lines: linesWithHeight(1, 120),
                  totalHeight: 120,
                },
              ],
              width: 114,
              height: 120,
            },
          ],
          height: 120,
        },
      ],
      columnWidths: [114],
      totalWidth: 114,
      totalHeight: 120,
    };

    const info = buildTableRowBreakInfo(block, measure);

    expect(info.breakOffsets[0]?.at(-1)).toBe(120);
    expect(
      info.breakOffsets[0]?.some((offset) => offset > 0 && offset < 120),
    ).toBe(true);
  });

  test("snaps to the deepest whole line that fits", () => {
    const { block, measure } = tallTable(3);
    const info = buildTableRowBreakInfo(block, measure);
    // limit 45 → lines at 20 and 40 fit, 60 doesn't → 40.
    expect(snapRowBreak(info, 0, 0, 45)).toBe(40);
    // From offset 40, 25 more px → next line bottom 60 fits → 20.
    expect(snapRowBreak(info, 0, 40, 25)).toBe(20);
    // Not even the first line fits.
    expect(snapRowBreak(info, 0, 0, 15)).toBe(0);
  });
});

const OPTIONS: LayoutOptions = {
  // content height = 200 - 40 - 40 = 120 px (6 lines).
  pageSize: { w: 300, h: 200 },
  margins: { top: 40, right: 40, bottom: 40, left: 40 },
  pageGap: 20,
};

function tableFragments(
  block: TableBlock,
  measure: TableMeasure,
): TableFragment[] {
  const layout = layoutDocument(
    [block as FlowBlock],
    [measure as Measure],
    OPTIONS,
  );
  return layout.pages
    .flatMap((page) => page.fragments)
    .filter((f): f is TableFragment => f.kind === "table");
}

describe("oversized table row splits across pages (#570)", () => {
  test("a row taller than a page breaks at line boundaries with no content lost", () => {
    // 15 lines = 300px row, page content height = 120px (6 lines).
    const { block, measure } = tallTable(15);
    const frags = tableFragments(block, measure);

    expect(frags.length).toBeGreaterThan(1);

    // First slice: starts at the row top (no topClip), cut mid-row (bottomClip).
    const first = frags[0]!;
    expect(first.topClip ?? 0).toBe(0);
    expect(first.bottomClip).toBeGreaterThan(0);
    expect(first.continuesOnNext).toBe(true);

    // A continuation slice resumes inside the row (topClip set).
    expect(frags.some((f) => (f.topClip ?? 0) > 0)).toBe(true);

    // Every cut lands on a whole line (multiple of the line height).
    for (const f of frags) {
      if (f.bottomClip !== undefined) {
        expect(f.bottomClip % LINE).toBe(0);
      }
      if (f.topClip !== undefined) {
        expect(f.topClip % LINE).toBe(0);
      }
    }

    // The last slice closes the row: no bottomClip, no continuation.
    const last = frags.at(-1)!;
    expect(last.bottomClip).toBeUndefined();
    expect(last.continuesOnNext ?? false).toBe(false);

    // No content lost: the slices tile the row exactly (each slice covers
    // [topClip, bottomClip ?? rowHeight)).
    const rowHeight = 15 * LINE;
    let covered = 0;
    for (const f of frags) {
      covered += (f.bottomClip ?? rowHeight) - (f.topClip ?? 0);
    }
    expect(covered).toBe(rowHeight);
  });

  test("does not skip a fresh first page with reduced content height", () => {
    const { block, measure } = tallTable(15);
    const layout = layoutDocument([block as FlowBlock], [measure as Measure], {
      ...OPTIONS,
      // First-page content height is 10px, smaller than one 20px line. The
      // first slice should still land on that fresh page instead of forcing
      // a blank page and retrying forever.
      firstPageMargins: { top: 40, right: 40, bottom: 150, left: 40 },
    });

    expect(layout.pages[0]?.fragments.length).toBeGreaterThan(0);
  });

  test("continues split rows into the next column before a new page", () => {
    const { block, measure } = tallTable(15);
    const layout = layoutDocument([block as FlowBlock], [measure as Measure], {
      ...OPTIONS,
      columns: { count: 2, gap: 20 },
    });
    const firstPageTableFragments =
      layout.pages[0]?.fragments.filter(
        (f): f is TableFragment => f.kind === "table",
      ) ?? [];

    expect(firstPageTableFragments.length).toBe(2);
    expect(firstPageTableFragments[0]?.x).toBe(OPTIONS.margins.left);
    expect(firstPageTableFragments[1]?.x).toBeGreaterThan(
      firstPageTableFragments[0]?.x ?? 0,
    );
  });

  test("preserves table alignment on split row fragments", () => {
    const { block, measure } = tallTable(15);
    block.justification = "center";
    block.columnWidths = [100];
    measure.columnWidths = [100];
    measure.totalWidth = 100;
    measure.rows[0]!.cells[0]!.width = 100; // SAFETY: tallTable creates one row with one cell.
    const frags = tableFragments(block, measure);
    const centeredX =
      OPTIONS.margins.left +
      (OPTIONS.pageSize.w -
        OPTIONS.margins.left -
        OPTIONS.margins.right -
        100) /
        2;

    expect(frags.length).toBeGreaterThan(1);
    expect(frags.every((f) => f.x === centeredX)).toBe(true);
  });

  test("uses the next column when no first slice fits remaining space", () => {
    const spacer: FlowBlock = {
      kind: "paragraph",
      id: "spacer",
      runs: [{ kind: "text", text: "spacer" }],
    };
    const spacerMeasure = paraMeasureWithLineHeight(1, 110);
    const { block, measure } = tallTable(15);
    const layout = layoutDocument(
      [spacer, block as FlowBlock],
      [spacerMeasure as Measure, measure as Measure],
      {
        ...OPTIONS,
        columns: { count: 2, gap: 20 },
      },
    );
    const firstPageTableFragments =
      layout.pages[0]?.fragments.filter(
        (f): f is TableFragment => f.kind === "table",
      ) ?? [];

    expect(firstPageTableFragments.length).toBeGreaterThan(0);
    expect(firstPageTableFragments[0]?.x).toBeGreaterThan(OPTIONS.margins.left);
  });

  test("uses space below the real header before repeating headers", () => {
    const { block, measure } = tableWithHeaderAndTallBody(15);
    const layout = layoutDocument(
      [block as FlowBlock],
      [measure as Measure],
      OPTIONS,
    );
    const frags = layout.pages
      .flatMap((page) => page.fragments)
      .filter((f): f is TableFragment => f.kind === "table");
    const firstPageFrags =
      layout.pages[0]?.fragments.filter(
        (f): f is TableFragment => f.kind === "table",
      ) ?? [];
    const bodyFrags = frags.filter((f) => f.fromRow === 1);

    expect(bodyFrags.length).toBeGreaterThan(1);
    expect(firstPageFrags.map((f) => [f.fromRow, f.toRow])).toEqual([
      [0, 1],
      [1, 2],
    ]);

    const pageContentHeight =
      OPTIONS.pageSize.h - OPTIONS.margins.top - OPTIONS.margins.bottom;
    const firstBodyFrag = bodyFrags[0]!;
    expect(firstBodyFrag.y).toBe(OPTIONS.margins.top + LINE);
    expect(firstBodyFrag.headerRowCount).toBeUndefined();
    expect(firstBodyFrag.height).toBe(pageContentHeight - LINE);

    for (const f of bodyFrags.slice(1)) {
      const visibleBodyHeight = (f.bottomClip ?? 15 * LINE) - (f.topClip ?? 0);
      expect(f.headerRowCount).toBe(1);
      expect(f.continuesFromPrev).toBe(true);
      expect(f.height).toBe(LINE + visibleBodyHeight);
      expect(f.height).toBeLessThanOrEqual(pageContentHeight);
    }
  });

  test("splits body rows that exceed the page only after headers repeat", () => {
    const { block, measure } = tableWithHeaderAndTallBody(6);
    const frags = tableFragments(block, measure);
    const bodyFrags = frags.filter((f) => f.fromRow === 1);
    const pageContentHeight =
      OPTIONS.pageSize.h - OPTIONS.margins.top - OPTIONS.margins.bottom;

    expect(bodyFrags.length).toBeGreaterThan(1);
    expect(bodyFrags[0]?.headerRowCount).toBeUndefined();
    expect(bodyFrags[0]?.height).toBe(pageContentHeight - LINE);

    for (const f of bodyFrags.slice(1)) {
      expect(f.headerRowCount).toBe(1);
      expect(f.height).toBeLessThanOrEqual(pageContentHeight);
    }
  });

  test("a normal row that fits a page is not clipped", () => {
    // 3 lines = 60px < 120px page → one whole-row fragment, no clips.
    const { block, measure } = tallTable(3);
    const frags = tableFragments(block, measure);

    expect(frags.length).toBe(1);
    expect(frags[0]!.topClip).toBeUndefined();
    expect(frags[0]!.bottomClip).toBeUndefined();
  });
});
