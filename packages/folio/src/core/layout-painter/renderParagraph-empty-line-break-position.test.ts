/**
 * Regression — a blank row produced by a hard line break (`<w:br/>`) must carry
 * a position the click/caret/visual-line resolvers can resolve.
 *
 * Such a line's only run is a line break, which renders as a bare `<br>`. The
 * resolvers in `clickToPositionDom.ts` only look for `span[data-pm-start]`, so
 * without a positioned span the blank row is invisible to them and they fall
 * back to the paragraph's start — collapsing clicks, the caret, and arrow
 * navigation onto the first line. `renderLine` injects a zero-width positioned
 * marker span carrying the break's pmStart so the row can be located.
 * (eigenpal/docx-editor#752.)
 */
import { describe, expect, test } from "bun:test";

import type { MeasuredLine, ParagraphBlock, Run } from "../layout-engine/types";
import { renderLine } from "./renderParagraph";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  textContent = "";
  classList = {
    add: (...tokens: string[]) => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };
  readonly tagName: string;

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

  prepend(...children: FakeElement[]): void {
    this.children.unshift(...children);
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

// "Hello" <br> <br> "World" — the middle visual line is empty (it spans only
// the second break, whose pmStart is 7).
const runs: Run[] = [
  { kind: "text", text: "Hello", pmStart: 1, pmEnd: 6 },
  { kind: "lineBreak", pmStart: 6, pmEnd: 7 },
  { kind: "lineBreak", pmStart: 7, pmEnd: 8 },
  { kind: "text", text: "World", pmStart: 8, pmEnd: 13 },
];
const block: ParagraphBlock = { kind: "paragraph", id: "p1", runs };

function line(fromRun: number, toRun: number, toChar: number): MeasuredLine {
  return {
    fromRun,
    fromChar: 0,
    toRun,
    toChar,
    width: 100,
    ascent: 10,
    descent: 3,
    lineHeight: 13,
  };
}

function render(measuredLine: MeasuredLine): FakeElement {
  return renderLine(block, measuredLine, undefined, fakeDocument, {
    availableWidth: 360,
    isLastLine: false,
    isFirstLine: false,
    paragraphEndsWithLineBreak: false,
    leftIndentPx: 0,
  }) as unknown as FakeElement;
}

function positionedSpans(lineEl: FakeElement): FakeElement[] {
  return lineEl.children.filter(
    (child) =>
      child.tagName === "span" &&
      child.dataset["pmStart"] !== undefined &&
      child.dataset["pmEnd"] !== undefined,
  );
}

describe("blank line-break rows carry a resolvable position", () => {
  test("the empty row gets a positioned marker span at the break position", () => {
    const lineEl = render(line(2, 2, 0));
    const marker = positionedSpans(lineEl).at(0);

    expect(marker).toBeDefined();
    expect(marker?.dataset["pmStart"]).toBe("7");
    expect(marker?.dataset["pmEnd"]).toBe("7");
    expect(marker?.textContent).toBe("\u200B");
  });

  test("the marker is placed before the <br> so its rect is on the blank row", () => {
    const lineEl = render(line(2, 2, 0));

    // The render loop appends the `<br>`, then the marker is prepended ahead of
    // it: a marker after the break would lay out one visual line lower, giving
    // the caret/click resolvers the wrong Y for the blank row.
    expect(lineEl.children.at(0)?.tagName).toBe("span");
    expect(lineEl.children.at(0)?.dataset["pmStart"]).toBe("7");
    expect(lineEl.children.at(1)?.tagName).toBe("br");
  });

  test("text rows are untouched (no injected marker)", () => {
    const lineEl = render(line(0, 0, 5));
    const spans = positionedSpans(lineEl);

    // Only the "Hello" run's span — no zero-width marker appended.
    expect(spans.map((s) => s.dataset["pmStart"])).toEqual(["1"]);
    expect(spans.every((s) => s.textContent !== "\u200B")).toBe(true);
  });

  test("a text+break row keeps the text span's position (no marker)", () => {
    const lineEl = render(line(0, 1, 0));
    const spans = positionedSpans(lineEl);

    expect(spans.map((s) => s.dataset["pmStart"])).toEqual(["1"]);
  });

  test("a trailing hard break resolves the blank row to after the break", () => {
    // "Hello" <br> — the paragraph ends with a break, so its final blank row has
    // no sliced runs and lands in the empty-line branch. It must resolve to the
    // position *after* the break (its pmEnd, 7), not before it (6) or the
    // paragraph start, or navigation would land back on the previous line.
    const trailingBlock: ParagraphBlock = {
      kind: "paragraph",
      id: "p2",
      pmStart: 0,
      pmEnd: 8,
      runs: [
        { kind: "text", text: "Hello", pmStart: 1, pmEnd: 6 },
        { kind: "lineBreak", pmStart: 6, pmEnd: 7 },
      ],
    };
    const lineEl = renderLine(
      trailingBlock,
      line(2, 2, 0),
      undefined,
      fakeDocument,
      {
        availableWidth: 360,
        isLastLine: true,
        isFirstLine: false,
        paragraphEndsWithLineBreak: true,
        leftIndentPx: 0,
      },
    ) as unknown as FakeElement;

    // Collapsed at 7 so a click anywhere on the row resolves to after the break.
    expect(lineEl.children.at(0)?.dataset["pmStart"]).toBe("7");
    expect(lineEl.children.at(0)?.dataset["pmEnd"]).toBe("7");
  });

  test("a floating image on a break row still gets a positioned marker", () => {
    // A floating image sits in the line's run range but the painter renders it
    // in a separate layer, so the visual row is just a `<br>`. The marker must
    // still be emitted (keyed off the in-flow break run) so the row is
    // resolvable. (eigenpal/docx-editor#752.)
    const floatBlock: ParagraphBlock = {
      kind: "paragraph",
      id: "p3",
      pmStart: 0,
      pmEnd: 4,
      runs: [
        {
          kind: "image",
          src: "data:image/png;base64,",
          width: 40,
          height: 40,
          wrapType: "square",
          pmStart: 1,
          pmEnd: 2,
        },
        { kind: "lineBreak", pmStart: 2, pmEnd: 3 },
      ],
    };
    const lineEl = renderLine(
      floatBlock,
      line(0, 1, 0),
      undefined,
      fakeDocument,
      {
        availableWidth: 360,
        isLastLine: true,
        isFirstLine: false,
        paragraphEndsWithLineBreak: true,
        leftIndentPx: 0,
      },
    ) as unknown as FakeElement;

    const marker = positionedSpans(lineEl).at(0);
    expect(marker?.dataset["pmStart"]).toBe("2");
  });
});
