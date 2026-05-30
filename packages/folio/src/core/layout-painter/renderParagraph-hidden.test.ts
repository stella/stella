// Regression eigenpal #424 gap 9 (w:vanish): hidden runs must stay in the DOM
// so PM cursor navigation works across hidden ranges. Word's editing view
// dims hidden text with a dotted underline instead of suppressing it; mirror
// that. A `docx-hidden` class hook lets host CSS opt into print-style
// suppression later without us changing the painter.

import { describe, expect, test } from "bun:test";

import type {
  MeasuredLine,
  ParagraphBlock,
  TextRun,
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

function findTextRunEls(lineEl: FakeElement): FakeElement[] {
  return lineEl.children.filter((c) => c.className.includes("layout-run-text"));
}

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

describe("renderParagraph w:vanish (hidden text) — eigenpal #424 gap 9", () => {
  test("hidden run renders with docx-hidden class and dimmed dotted-underline style", () => {
    const { block, line } = buildLine([
      { kind: "text", text: "visible " },
      { kind: "text", text: "secret", hidden: true },
    ]);

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops: [],
      leftIndentPx: 0,
      lineRightEdgePx: 600,
    }) as unknown as FakeElement;

    const textEls = findTextRunEls(lineEl);
    // Both runs must remain in the DOM — display:none would orphan PM
    // positions and break cursor navigation across the hidden boundary.
    expect(textEls).toHaveLength(2);

    const [visibleEl, hiddenEl] = textEls as [FakeElement, FakeElement];

    // Visible run: no hidden treatment.
    expect(visibleEl.className).not.toContain("docx-hidden");
    expect(visibleEl.style["opacity"]).toBeUndefined();
    expect(visibleEl.style["textDecoration"]).toBeUndefined();

    // Hidden run: dimmed with dotted underline, class hook present.
    expect(hiddenEl.className).toContain("docx-hidden");
    expect(hiddenEl.style["opacity"]).toBe("0.4");
    expect(hiddenEl.style["textDecoration"]).toBe("underline dotted");
    // Text content is preserved so the cursor has something to land on.
    expect(hiddenEl.textContent).toBe("secret");
  });

  test("non-hidden run does NOT receive docx-hidden class or dim styles", () => {
    const { block, line } = buildLine([{ kind: "text", text: "plain" }]);

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 600,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops: [],
      leftIndentPx: 0,
      lineRightEdgePx: 600,
    }) as unknown as FakeElement;

    const [textEl] = findTextRunEls(lineEl) as [FakeElement];
    expect(textEl.className).not.toContain("docx-hidden");
    expect(textEl.style["opacity"]).toBeUndefined();
    expect(textEl.style["textDecoration"]).toBeUndefined();
  });
});
