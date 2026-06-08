// eigenpal #730 (#729) — a numbered list whose direct paragraph indent has
// `hanging` greater than `left` must hang its marker into the left margin (as
// Word does), not clamp it to the content edge. The marker line keeps
// `text-indent: 0` and the hang comes from padding-left; CSS padding can't be
// negative, so when `left - hanging < 0` the negative portion rides on the
// marker's own `margin-left`. Without it the old `Math.max(0, left - hanging)`
// clamp pinned the marker to the content edge, shifting the numbers right of
// the text above.

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

function renderListItem(indent: { left: number; hanging: number }): {
  line: HTMLElement;
  marker: HTMLElement | undefined;
} {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: "p1",
    runs: [{ kind: "text", text: "TEST1" }],
    attrs: { listMarker: "1.", indent },
  };
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: 0,
        toChar: 5,
        width: 40,
        ascent: 10,
        descent: 3,
        lineHeight: 14,
      },
    ],
    totalHeight: 14,
  };
  const fragment: ParagraphFragment = {
    kind: "paragraph",
    blockId: "p1",
    x: 0,
    y: 0,
    width: 400,
    height: 14,
    fromLine: 0,
    toLine: 1,
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
    const line = fragmentEl.children[0] as HTMLElement;
    const marker = line.children[0] as HTMLElement | undefined;
    return { line, marker };
  } finally {
    clearTextWidthCache();
    resetCanvasContext();
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
    });
  }
}

describe("Issue #729 — list hanging indent exceeding left indent", () => {
  test("hanging > left: marker hangs into the margin via negative margin-left", () => {
    // 15px left, 38px hanging — marker should start at 15 - 38 = -23px.
    const { line, marker } = renderListItem({ left: 15, hanging: 38 });
    expect(marker?.className).toContain("layout-list-marker");
    expect(Number.parseFloat(marker?.style.marginLeft ?? "")).toBeCloseTo(
      -23,
      1,
    );
    // padding clamps to 0 (can't be negative); text-indent stays 0.
    expect(line.style.paddingLeft).toBe("0px");
    expect(line.style.textIndent).toBe("0");
  });

  test("hanging <= left: existing path unchanged (padding, no marker margin)", () => {
    // 48px left, 24px hanging — marker starts at 48 - 24 = 24px via padding.
    const { line, marker } = renderListItem({ left: 48, hanging: 24 });
    expect(marker?.style.marginLeft).toBeFalsy();
    expect(line.style.paddingLeft).toBe("24px");
    expect(line.style.textIndent).toBe("0");
  });

  test("left == 0 with hanging: no negative margin (continuation lines sit at hanging)", () => {
    // Gating on indentLeft > 0 avoids misaligning the first line with the
    // continuation lines, which the body-line branch places at `hanging`.
    const { line, marker } = renderListItem({ left: 0, hanging: 24 });
    expect(marker?.style.marginLeft).toBeFalsy();
    expect(line.style.paddingLeft).toBe("0px");
  });
});
