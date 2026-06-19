// eigenpal/docx-editor#868 — a justified paragraph with a first-line indent
// must justify its first line to the FULL content width. The first-line shift
// is realized purely by `text-indent`; narrowing the justify box by `firstLine`
// as well double-counted the indent, leaving the first line's right edge short
// of the right margin while body lines reached it.

import { describe, expect, test } from "bun:test";

import { clearTextWidthCache } from "../layout-engine/measure/cache";
import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import type {
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMeasure,
} from "../layout-engine/types";
import { renderParagraphFragment } from "./renderParagraph";

function createFakeStyle(): Record<string, string> {
  const store: Record<string, string> = {};
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop === "setProperty") {
        return (key: string, value: string) => {
          target[key] = value;
        };
      }
      if (prop === "getPropertyValue") {
        return (key: string) => target[key] ?? "";
      }
      return target[prop];
    },
    set(target, prop: string, value: string) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Record<string, string>;
}

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  innerHTML = "";
  dir = "";
  style: Record<string, string> = createFakeStyle();
  children: FakeElement[] = [];
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
  prepend(...children: FakeElement[]): void {
    this.children.unshift(...children);
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
    return { font: "", measureText: (t: string) => ({ width: t.length * 7 }) };
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function renderJustifiedFirstLine(firstLine: number): {
  firstLineEl: HTMLElement;
} {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: "p1",
    runs: [{ kind: "text", text: "first second third fourth fifth sixth" }],
    attrs: { alignment: "justify", indent: { firstLine } },
  };
  const line = (toChar: number, fromChar: number) => ({
    fromRun: 0,
    fromChar,
    toRun: 0,
    toChar,
    width: 380,
    ascent: 10,
    descent: 3,
    lineHeight: 14,
  });
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    // Two lines: the first is justified, the second is the (left-aligned) last.
    lines: [line(18, 0), line(36, 18)],
    totalHeight: 28,
  };
  const fragment: ParagraphFragment = {
    kind: "paragraph",
    blockId: "p1",
    x: 0,
    y: 0,
    width: 400, // no left/right indent → availableWidth === 400
    height: 28,
    fromLine: 0,
    toLine: 2,
  };

  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    value: fakeDocument,
    configurable: true,
  });
  clearTextWidthCache();
  resetCanvasContext();
  try {
    const fragmentEl = renderParagraphFragment(
      fragment,
      block,
      measure,
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument },
    );
    return { firstLineEl: fragmentEl.children[0] as HTMLElement };
  } finally {
    clearTextWidthCache();
    resetCanvasContext();
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
    });
  }
}

describe("Issue #868 — justify first line to full content width on indented paragraphs", () => {
  test("first line justify box is the full content width, not narrowed by firstLine", () => {
    const { firstLineEl } = renderJustifiedFirstLine(30);
    // availableWidth is the full 400px content width; the first-line shift is
    // applied via text-indent, NOT by shrinking the justify box to 370px.
    expect(firstLineEl.style.width).toBe("400px");
    expect(firstLineEl.style.textIndent).toBe("30px");
    expect(firstLineEl.style.textAlign).toBe("justify");
  });
});
