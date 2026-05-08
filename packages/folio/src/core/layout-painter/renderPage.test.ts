import { describe, expect, test } from "bun:test";

import type {
  Page,
  ParagraphBlock,
  ParagraphMeasure,
  TableBlock,
  TableMeasure,
} from "../layout-engine/types";
import type { BlockLookup } from "./index";
import {
  computePageFingerprint,
  getDefaultPageFontFamily,
  renderPage,
  renderFootnoteArea,
} from "./renderPage";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private ownText = "";
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  getContext(): null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
  createTextNode(text: string): FakeElement {
    const node = new FakeElement("#text");
    node.textContent = text;
    return node;
  },
} as unknown as Document;

function collectPmAnchors(element: FakeElement): FakeElement[] {
  const ownAnchorKeys = Object.keys(element.dataset).filter((key) =>
    key.toLowerCase().includes("pm"),
  );
  const anchors = ownAnchorKeys.length > 0 ? [element] : [];

  for (const child of element.children) {
    anchors.push(...collectPmAnchors(child));
  }

  return anchors;
}

function findByClass(
  element: FakeElement,
  className: string,
): FakeElement | undefined {
  if (element.className.split(" ").includes(className)) {
    return element;
  }

  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) {
      return match;
    }
  }

  return undefined;
}

const page: Page = {
  number: 1,
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
  size: { w: 816, h: 1056 },
  fragments: [
    {
      kind: "paragraph",
      blockId: "p1",
      x: 72,
      y: 72,
      width: 672,
      height: 24,
      fromLine: 0,
      toLine: 1,
      pmStart: 1,
      pmEnd: 12,
    },
  ],
};

function blockWithComment(commentId?: number): ParagraphBlock {
  return {
    kind: "paragraph",
    id: "p1",
    runs: [
      {
        kind: "text",
        text: "commented",
        pmStart: 1,
        pmEnd: 10,
        ...(commentId !== undefined ? { commentIds: [commentId] } : {}),
      },
    ],
  };
}

function lookup(block: ParagraphBlock): BlockLookup {
  return new Map([
    [
      "p1",
      { block, measure: { kind: "paragraph", lines: [], totalHeight: 0 } },
    ],
  ]);
}

describe("render page fingerprint", () => {
  test("changes when comment annotations change without layout geometry changing", () => {
    expect(computePageFingerprint(page, lookup(blockWithComment()))).not.toBe(
      computePageFingerprint(page, lookup(blockWithComment(123))),
    );
  });
});

describe("page font fallback", () => {
  test("uses the same metric-compatible Calibri fallback as text measurement", () => {
    expect(getDefaultPageFontFamily()).toBe(
      "Calibri, Carlito, Arial, Helvetica, sans-serif",
    );
  });
});

describe("header and footer rendering", () => {
  test("dims header and footer chrome while editing body content", () => {
    const pageElement = renderPage(
      { ...page, fragments: [] },
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument },
    );

    expect(
      findByClass(pageElement as unknown as FakeElement, "layout-page-header")
        ?.style.opacity,
    ).toBe("0.62");
    expect(
      findByClass(pageElement as unknown as FakeElement, "layout-page-footer")
        ?.style.opacity,
    ).toBe("0.62");
  });
});

describe("footnote rendering", () => {
  test("renders structured footnote fields with the page render context", () => {
    const footnoteParagraph: ParagraphBlock = {
      kind: "paragraph",
      id: "fn-page-field",
      runs: [
        { kind: "text", text: "Page " },
        { kind: "field", fieldType: "PAGE", fallback: "0" },
        { kind: "text", text: " of " },
        { kind: "field", fieldType: "NUMPAGES", fallback: "0" },
      ],
    };
    const footnoteMeasure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 3,
          toChar: 1,
          width: 72,
          ascent: 8,
          descent: 2,
          lineHeight: 12,
        },
      ],
      totalHeight: 12,
    };

    const pageEl = renderPage(
      {
        ...page,
        footnoteReservedHeight: 24,
        fragments: [],
      },
      { pageNumber: 7, totalPages: 9, section: "body" },
      {
        document: fakeDocument,
        footnoteArea: [
          {
            displayNumber: "1",
            content: {
              blocks: [footnoteParagraph],
              measures: [footnoteMeasure],
              height: 12,
            },
          },
        ],
      },
    );

    expect(pageEl.textContent).toContain("Page 7 of 9");
  });

  test("renders structured table footnote content without body PM anchors", () => {
    const tableBlock: TableBlock = {
      kind: "table",
      id: "fn-table",
      pmStart: 1,
      pmEnd: 20,
      rows: [
        {
          id: "row-1",
          cells: [
            {
              id: "cell-1",
              blocks: [
                {
                  kind: "paragraph",
                  id: "cell-p-1",
                  pmStart: 2,
                  pmEnd: 8,
                  runs: [{ kind: "text", text: "Cell", pmStart: 3, pmEnd: 7 }],
                },
              ],
              padding: { top: 0, right: 7, bottom: 0, left: 7 },
            },
          ],
        },
      ],
      columnWidths: [100],
    };
    const tableMeasure: TableMeasure = {
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
                      fromRun: 0,
                      fromChar: 0,
                      toRun: 0,
                      toChar: 4,
                      width: 24,
                      ascent: 8,
                      descent: 2,
                      lineHeight: 12,
                    },
                  ],
                  totalHeight: 12,
                },
              ],
              width: 100,
              height: 12,
            },
          ],
          height: 12,
        },
      ],
      columnWidths: [100],
      totalWidth: 100,
      totalHeight: 12,
    };

    const footnoteArea = renderFootnoteArea(
      [
        {
          displayNumber: "1",
          content: {
            blocks: [tableBlock],
            measures: [tableMeasure],
            height: 12,
          },
        },
      ],
      400,
      fakeDocument,
    );

    expect(footnoteArea.textContent).toContain("Cell");
    expect(collectPmAnchors(footnoteArea as unknown as FakeElement)).toEqual(
      [],
    );
  });
});
