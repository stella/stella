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

const renderContext: RenderContext = {
  pageNumber: 1,
  totalPages: 1,
  section: "body",
};

function findRows(element: FakeElement): FakeElement[] {
  const matches: FakeElement[] = [];
  if (element.className.split(" ").includes(TABLE_CLASS_NAMES.row)) {
    matches.push(element);
  }
  for (const child of element.children) {
    matches.push(...findRows(child));
  }
  return matches;
}

function buildHeaderContinuation(): {
  fragment: TableFragment;
  block: TableBlock;
  measure: TableMeasure;
} {
  const block: TableBlock = {
    kind: "table",
    id: "tbl",
    rows: [
      {
        id: "header",
        isHeader: true,
        cells: [
          {
            id: "header-cell",
            blocks: [
              {
                kind: "paragraph",
                id: "header-p",
                runs: [{ kind: "text", text: "Header" }],
              },
            ],
          },
        ],
      },
      {
        id: "body",
        cells: [
          {
            id: "body-cell",
            blocks: [
              {
                kind: "paragraph",
                id: "body-p",
                runs: [{ kind: "text", text: "Body" }],
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
                lines: [],
                totalHeight: 20,
              },
            ],
            width: 100,
            height: 20,
          },
        ],
        height: 20,
      },
      {
        cells: [
          {
            blocks: [
              {
                kind: "paragraph",
                lines: [],
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
    totalHeight: 120,
  };
  const fragment: TableFragment = {
    kind: "table",
    blockId: "tbl",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    fromRow: 1,
    toRow: 2,
    continuesFromPrev: true,
    headerRowCount: 1,
    topClip: 40,
    bottomClip: 100,
  };
  return { fragment, block, measure };
}

describe("renderTableFragment clipped header continuations", () => {
  test("keeps repeated headers pinned while clipping the body row", () => {
    const { fragment, block, measure } = buildHeaderContinuation();

    const tableEl = renderTableFragment(
      fragment,
      block,
      measure,
      renderContext,
      { document: fakeDocument },
    ) as unknown as FakeElement;

    const rows = findRows(tableEl);
    const headerRow = rows.find(
      (row) => row.dataset["repeatedHeader"] === "true",
    );
    const bodyRow = rows.find((row) => row.dataset["rowIndex"] === "1");
    const clipElement = tableEl.children.find(
      (child) =>
        child.style["top"] === "20px" &&
        child.style["height"] === "60px" &&
        child.style["overflow"] === "hidden",
    );

    expect(headerRow?.style["top"]).toBe("0px");
    expect(bodyRow?.style["top"]).toBe("-40px");
    expect(clipElement).toBeDefined();
  });
});
