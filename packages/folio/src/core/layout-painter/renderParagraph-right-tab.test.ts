// Regression eigenpal #566 (renderer half): a right-aligned tab whose stop
// sits at the line's right edge with no trailing tab should promote the line
// to a flex row — tab gets `flex: 1 1 0`, trailing text/field sits flush
// against the line's right edge. Canvas-measured widths and DOM layout drift
// by sub-pixels under accumulation, so geometry alone leaves TOC page numbers
// one pixel short of the margin; flex layout pins them.

import { describe, expect, test } from "bun:test";

import type {
  MeasuredLine,
  ParagraphBlock,
  TabStop,
} from "../layout-engine/types";
import { renderLine } from "./renderParagraph";

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
  height = 0;
  width = 0;
  src = "";
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

  get firstElementChild(): FakeElement | null {
    return this.children.at(0) ?? null;
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
        // 7px per character keeps the math simple; bold/italic don't change
        // the count here because the right-tab anchor doesn't depend on the
        // exact width, only on whether `currentX + tab + trailing` reaches
        // the right edge.
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

function findTabEl(lineEl: FakeElement): FakeElement | undefined {
  return lineEl.children.find((c) => c.className.includes("layout-run-tab"));
}

function findFieldOrTextEls(lineEl: FakeElement): FakeElement[] {
  return lineEl.children.filter((c) => c.className.includes("layout-run-text"));
}

describe("renderLine right-tab flex anchor", () => {
  // TOC1-style line: title text + right-aligned tab + page-number field.
  // Tab stop sits at the line's right edge; with no trailing tab and a tab
  // alignment of "end", the painter must promote the line to flex layout.
  test("promotes a TOC line to flex when right-aligned tab sits at the edge", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "toc1",
      runs: [
        { kind: "text", text: "Chapter One" },
        { kind: "tab" },
        { kind: "field", fieldType: "PAGE", fallback: "5" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 600,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };
    const tabStops: TabStop[] = [
      // Right-aligned ("end") tab stop at ~600px (9000 twips = 9000/15 ≈ 600px).
      { val: "end", pos: 9000, leader: "dot" },
    ];

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops,
      leftIndentPx: 0,
      lineRightEdgePx: 600,
    }) as unknown as FakeElement;

    expect(lineEl.dataset["flexLine"]).toBe("true");
    expect(lineEl.style["display"]).toBe("flex");
    expect(lineEl.style["alignItems"]).toBe("baseline");
    expect(lineEl.style["whiteSpace"]).toBe("nowrap");

    const tabEl = findTabEl(lineEl);
    expect(tabEl).toBeDefined();
    // flex: 1 1 0 lets the tab grow to fill the remaining space.
    expect(tabEl?.style["flex"]).toBe("1 1 0");

    // The trailing field run lands AFTER the tab in flex order so layout
    // pushes it flush right.
    const trailing = findFieldOrTextEls(lineEl);
    // Title + page number — both are text-class spans (field renders via
    // renderTextRun's "text" path with field-resolved content).
    expect(trailing.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT promote to flex when the right-aligned tab is not the last on the line", () => {
    // Two end-aligned tabs on one line — the first tab must NOT fire the
    // anchor (it has a following tab), so its trailing content lays out
    // naturally up to the next tab. Only the LAST tab is eligible for the
    // right-edge anchor.
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "two-tabs",
      runs: [
        { kind: "text", text: "A" },
        { kind: "tab" },
        { kind: "text", text: "B" },
        { kind: "tab" },
        { kind: "text", text: "C" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 4,
      toChar: 1,
      width: 600,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };
    // Both stops are NOT at the right edge (line edge = 600px = 9000 twips).
    // The first stop sits at pos 1500 (~100px), the second at pos 3000 (~200px) —
    // currentX + tab + trailing stays well below 600, so neither tab reaches
    // the anchor's right-edge threshold even though both are end-aligned.
    const tabStops: TabStop[] = [
      { val: "end", pos: 1500, leader: "dot" },
      { val: "end", pos: 3000, leader: "dot" },
    ];

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops,
      leftIndentPx: 0,
      lineRightEdgePx: 600,
    }) as unknown as FakeElement;

    expect(lineEl.dataset["flexLine"]).toBeUndefined();
    expect(lineEl.style["display"]).not.toBe("flex");
  });

  test("does NOT promote to flex when no lineRightEdgePx is provided", () => {
    // Backwards-compat: callers that don't pass lineRightEdgePx (older code
    // paths, table cells before the rewrite) keep the existing non-flex
    // tab rendering. The anchor must opt in via the new option.
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "no-edge",
      runs: [
        { kind: "text", text: "title" },
        { kind: "tab" },
        { kind: "text", text: "5" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 600,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops: [{ val: "end", pos: 9000, leader: "dot" }],
      leftIndentPx: 0,
      // No lineRightEdgePx.
    }) as unknown as FakeElement;

    expect(lineEl.dataset["flexLine"]).toBeUndefined();
  });
});

describe("renderTabRun leader rendering", () => {
  // Regression: the SVG background-image leader sat at the line's bottom
  // edge and broke under flex layout. The new pattern uses an absolutely
  // positioned inner span over a zero-width-space, so the outer span keeps
  // its baseline aligned with surrounding text while the leader clips
  // horizontally inside.
  test("renders dot leader as an absolutely-positioned inner span", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "leader-only",
      runs: [
        { kind: "text", text: "x" },
        { kind: "tab" },
        { kind: "text", text: "y" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 600,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops: [{ val: "end", pos: 9000, leader: "dot" }],
      leftIndentPx: 0,
      lineRightEdgePx: 600,
    }) as unknown as FakeElement;

    const tabEl = findTabEl(lineEl);
    expect(tabEl).toBeDefined();
    // The outer tab span is position: relative; the inner leader span is
    // position: absolute and clips horizontally.
    expect(tabEl?.style["position"]).toBe("relative");
    const inner = tabEl?.children.at(0);
    expect(inner).toBeDefined();
    expect(inner?.style["position"]).toBe("absolute");
    expect(inner?.style["overflow"]).toBe("hidden");
    expect(inner?.style["whiteSpace"]).toBe("nowrap");
    // Leader is repeated to fill the box; the exact count is an implementation
    // detail (LEADER_FILL_COUNT). What matters is that it's many dots, not one.
    const innerText = inner?.textContent ?? "";
    expect(innerText.length).toBeGreaterThan(100);
    expect(innerText.startsWith(".")).toBe(true);
  });
});
