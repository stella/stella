// Regression eigenpal #424 gap 14: `w:noWrap` on a table cell must reach the
// painter. The parser captured it and the PM schema stored it, but the
// layout-bridge dropped the field on the way to TableCell, and renderTable
// never emitted `white-space: nowrap`. Cells like case numbers and citations
// wrapped where Word kept them on a single line.

import { describe, expect, test } from "bun:test";

import type {
  TableBlock,
  TableFragment,
  TableMeasure,
} from "../layout-engine/types";
import { renderTableFragment, TABLE_CLASS_NAMES } from "./renderTable";
import type { RenderContext } from "./renderUtils";

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

function findCells(element: FakeElement): FakeElement[] {
  const matches: FakeElement[] = [];
  if (element.className.split(" ").includes(TABLE_CLASS_NAMES.cell)) {
    matches.push(element);
  }
  for (const child of element.children) {
    matches.push(...findCells(child));
  }
  return matches;
}

function buildSingleCellTable(noWrap?: boolean): {
  fragment: TableFragment;
  block: TableBlock;
  measure: TableMeasure;
} {
  const block: TableBlock = {
    kind: "table",
    id: "tbl",
    rows: [
      {
        id: "row-1",
        cells: [
          {
            id: "cell-1",
            blocks: [
              {
                kind: "paragraph",
                id: "p-1",
                runs: [{ kind: "text", text: "CASE 123-456" }],
              },
            ],
            padding: { top: 0, right: 7, bottom: 0, left: 7 },
            ...(noWrap === undefined ? {} : { noWrap }),
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
                lines: [
                  {
                    fromRun: 0,
                    fromChar: 0,
                    toRun: 0,
                    toChar: 12,
                    width: 80,
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
  const fragment: TableFragment = {
    kind: "table",
    blockId: "tbl",
    x: 0,
    y: 0,
    width: 100,
    height: 12,
    fromRow: 0,
    toRow: 1,
  };
  return { fragment, block, measure };
}

const renderContext: RenderContext = {
  pageNumber: 1,
  totalPages: 1,
  section: "body",
};

describe("renderTable cell w:noWrap (eigenpal #424 gap 14)", () => {
  test("emits white-space: nowrap on the cell element when cell.noWrap is true", () => {
    const { fragment, block, measure } = buildSingleCellTable(true);

    const tableEl = renderTableFragment(
      fragment,
      block,
      measure,
      renderContext,
      {
        document: fakeDocument,
      },
    ) as unknown as FakeElement;

    const cells = findCells(tableEl);
    expect(cells.length).toBe(1);
    expect(cells[0]?.style["whiteSpace"]).toBe("nowrap");
  });

  test("does NOT set white-space on the cell element when cell.noWrap is absent", () => {
    const { fragment, block, measure } = buildSingleCellTable(undefined);

    const tableEl = renderTableFragment(
      fragment,
      block,
      measure,
      renderContext,
      {
        document: fakeDocument,
      },
    ) as unknown as FakeElement;

    const cells = findCells(tableEl);
    expect(cells.length).toBe(1);
    expect(cells[0]?.style["whiteSpace"]).toBeUndefined();
  });

  test("does NOT set white-space on the cell element when cell.noWrap is false", () => {
    const { fragment, block, measure } = buildSingleCellTable(false);

    const tableEl = renderTableFragment(
      fragment,
      block,
      measure,
      renderContext,
      {
        document: fakeDocument,
      },
    ) as unknown as FakeElement;

    const cells = findCells(tableEl);
    expect(cells.length).toBe(1);
    expect(cells[0]?.style["whiteSpace"]).toBeUndefined();
  });
});
