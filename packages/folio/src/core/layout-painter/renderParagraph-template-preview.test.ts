// Template fill preview: the layout pipeline substitutes typed values into
// the flow blocks, so the painter must (1) mark substituted runs with the
// preview classes — highlighted mode paints the accent chip as a
// layout-aware inline highlight — and (2) clamp line-sliced pm spans to the
// run's own pmEnd, because a value run keeps the source marker's PM range
// while carrying text of a different length.

import { describe, expect, test } from "bun:test";

import type {
  MeasuredLine,
  ParagraphBlock,
  TextRun,
} from "../layout-engine/types";
import { renderLine, sliceRunsForLine } from "./renderParagraph";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  innerHTML = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    add: (...tokens: string[]) => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };
  readonly tagName: string;
  textContent = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  getContext(): {
    font: string;
    measureText: (text: string) => { width: number };
  } | null {
    if (this.tagName !== "canvas") {
      return null;
    }
    return {
      font: "",
      measureText(text: string) {
        return { width: text.length * 7 };
      },
    };
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function buildLine(runs: TextRun[]): {
  block: ParagraphBlock;
  line: MeasuredLine;
} {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: "p",
    runs,
  };
  const lastRun = runs.at(-1);
  if (!lastRun) {
    throw new Error("buildLine requires at least one run");
  }
  const line: MeasuredLine = {
    fromRun: 0,
    fromChar: 0,
    toRun: runs.length - 1,
    toChar: lastRun.text.length,
    width: 200,
    ascent: 12,
    descent: 3,
    lineHeight: 15,
  };
  return { block, line };
}

function findTextRunEls(lineEl: FakeElement): FakeElement[] {
  return lineEl.children.filter((c) => c.className.includes("layout-run-text"));
}

function renderFakeLine(block: ParagraphBlock, line: MeasuredLine) {
  return renderLine(block, line, undefined, fakeDocument, {
    availableWidth: 600,
    isLastLine: true,
    isFirstLine: true,
    paragraphEndsWithLineBreak: false,
    tabStops: [],
    leftIndentPx: 0,
    lineRightEdgePx: 600,
  }) as unknown as FakeElement;
}

describe("renderParagraph template fill preview", () => {
  test("highlighted substitution paints the preview run classes", () => {
    const { block, line } = buildLine([
      { kind: "text", text: "Name: " },
      { kind: "text", text: "Maciej Kur", templatePreview: "highlighted" },
    ]);

    const [plainEl, valueEl] = findTextRunEls(renderFakeLine(block, line)) as [
      FakeElement,
      FakeElement,
    ];

    expect(plainEl.className).not.toContain("folio-template-preview-run");
    expect(valueEl.className).toContain("folio-template-preview-run");
    expect(valueEl.className).toContain(
      "folio-template-preview-run--highlighted",
    );
    expect(valueEl.textContent).toBe("Maciej Kur");
  });

  test("plain substitution gets the marker class without the accent chip", () => {
    const { block, line } = buildLine([
      { kind: "text", text: "1234", templatePreview: "plain" },
    ]);

    const [valueEl] = findTextRunEls(renderFakeLine(block, line)) as [
      FakeElement,
    ];

    expect(valueEl.className).toContain("folio-template-preview-run");
    expect(valueEl.className).not.toContain(
      "folio-template-preview-run--highlighted",
    );
  });

  test("sliceRunsForLine clamps sliced pm spans to the value run's marker range", () => {
    // A 10-char value over a 4-position marker [5, 9): a line break after
    // char 6 must not project pm positions past the marker end, or the
    // painted span would claim the following text's PM range.
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p",
      runs: [
        {
          kind: "text",
          text: "0123456789",
          pmStart: 5,
          pmEnd: 9,
          templatePreview: "plain",
        },
      ],
    };
    const firstLine: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 6,
      width: 42,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };
    const secondLine: MeasuredLine = { ...firstLine, fromChar: 6, toChar: 10 };

    const [firstSlice] = sliceRunsForLine(block, firstLine) as [TextRun];
    expect(firstSlice.text).toBe("012345");
    expect([firstSlice.pmStart, firstSlice.pmEnd]).toEqual([5, 9]);

    const [secondSlice] = sliceRunsForLine(block, secondLine) as [TextRun];
    expect(secondSlice.text).toBe("6789");
    expect([secondSlice.pmStart, secondSlice.pmEnd]).toEqual([9, 9]);
  });

  test("sliceRunsForLine keeps exact pm spans for ordinary runs", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p",
      runs: [{ kind: "text", text: "hello world", pmStart: 1, pmEnd: 12 }],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 6,
      toRun: 0,
      toChar: 11,
      width: 35,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const [slice] = sliceRunsForLine(block, line) as [TextRun];
    expect(slice.text).toBe("world");
    expect([slice.pmStart, slice.pmEnd]).toEqual([7, 12]);
  });
});
