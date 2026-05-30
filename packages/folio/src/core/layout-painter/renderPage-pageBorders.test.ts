/**
 * Painter coverage for `<w:pgBorders>` rendering (ECMA-376 §17.6.10).
 *
 * Verifies the overlay geometry, `display` gating, `offsetFrom`, `zOrder`,
 * per-side independence, and edge cases (no-op styles, hairline floor,
 * double-line floor). Mirrors the eigenpal `border-overlay-layout` test
 * (see `git show eigenpal/main:packages/core/src/layout-painter/__tests__/border-overlay-layout.test.ts`)
 * but uses folio's lightweight FakeElement harness instead of happy-dom
 * to keep the suite Bun-native.
 */

import { describe, expect, test } from "bun:test";

import type { Page } from "../layout-engine/types";
import { eighthsToPixels, pointsToPixels } from "../utils/units";
import { renderPage } from "./renderPage";
import type { RenderPageOptions } from "./renderPage";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private ownText = "";
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  prepend(...children: FakeElement[]): void {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      child.parent = this;
      this.children.unshift(child);
    }
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parent) {
      return;
    }
    const idx = this.parent.children.indexOf(this);
    if (idx !== -1) {
      this.parent.children.splice(idx, 1);
    }
    this.parent = null;
  }

  getContext(): null {
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return findByClass(this, classFromSelector(selector));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    collectByClass(this, classFromSelector(selector), out);
    return out;
  }
}

const CLASS_SELECTOR_RE = /\.([\w-]+)/u;

const classFromSelector = (selector: string): string => {
  // Tests pass either `.layout-page-border` or `:scope > .layout-page-border`.
  const match = CLASS_SELECTOR_RE.exec(selector);
  return match ? (match[1] ?? "") : selector;
};

const findByClass = (
  root: FakeElement,
  className: string,
): FakeElement | null => {
  for (const child of root.children) {
    if (
      child.className.split(/\s+/u).includes(className) ||
      child.tagName === className
    ) {
      return child;
    }
    const inner = findByClass(child, className);
    if (inner) {
      return inner;
    }
  }
  return null;
};

const collectByClass = (
  root: FakeElement,
  className: string,
  out: FakeElement[],
): void => {
  for (const child of root.children) {
    if (
      child.className.split(/\s+/u).includes(className) ||
      child.tagName === className
    ) {
      out.push(child);
    }
    collectByClass(child, className, out);
  }
};

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

const makePage = (overrides: Partial<Page> = {}): Page => ({
  number: 1,
  fragments: [],
  margins: { top: 54, right: 36, bottom: 52, left: 54 },
  size: { w: 816, h: 1056 },
  ...overrides,
});

const renderWithBorders = (
  page: Page,
  pageBorders: NonNullable<RenderPageOptions["pageBorders"]>,
): FakeElement =>
  renderPage(
    page,
    { pageNumber: page.number, totalPages: 1, section: "body" },
    {
      document: fakeDocument,
      pageBorders,
    },
  ) as unknown as FakeElement;

const borderOverlay = (pageEl: FakeElement): FakeElement | null =>
  pageEl.querySelector(".layout-page-border");

describe("renderPageBorderOverlay", () => {
  test("renders an inset overlay with all four sides applied", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
      bottom: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
      left: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
      right: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl);
    expect(overlay).not.toBeNull();
    expect(overlay!.style["borderTopStyle"]).toBe("solid");
    expect(overlay!.style["borderBottomStyle"]).toBe("solid");
    expect(overlay!.style["borderLeftStyle"]).toBe("solid");
    expect(overlay!.style["borderRightStyle"]).toBe("solid");
  });

  test("offsetFrom='page' positions the overlay from the page edges", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 4, space: 24, color: { rgb: "000000" } },
      left: { style: "single", size: 4, space: 24, color: { rgb: "000000" } },
      bottom: { style: "single", size: 4, space: 24, color: { rgb: "000000" } },
      right: { style: "single", size: 4, space: 24, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl)!;
    const expected = `${pointsToPixels(24)}px`;
    expect(overlay.style["top"]).toBe(expected);
    expect(overlay.style["bottom"]).toBe(expected);
    expect(overlay.style["left"]).toBe(expected);
    expect(overlay.style["right"]).toBe(expected);
  });

  test("offsetFrom='text' shifts the overlay outward by both space and stroke width", () => {
    // Doubled stroke is forced to >= 3px by the painter so browsers do not
    // collapse it to a single line; the overlay must shift outward by the
    // exact stroke that will paint.
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "text",
      top: { style: "double", size: 4, space: 15, color: { rgb: "000000" } },
      left: { style: "double", size: 4, space: 15, color: { rgb: "000000" } },
      bottom: { style: "double", size: 4, space: 11, color: { rgb: "000000" } },
      right: { style: "double", size: 4, space: 2, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl)!;
    const stroke = 3; // doubled stroke floor
    expect(Number.parseFloat(overlay.style["top"] ?? "")).toBeCloseTo(
      54 - pointsToPixels(15) - stroke,
      5,
    );
    expect(Number.parseFloat(overlay.style["left"] ?? "")).toBeCloseTo(
      54 - pointsToPixels(15) - stroke,
      5,
    );
    expect(Number.parseFloat(overlay.style["bottom"] ?? "")).toBeCloseTo(
      52 - pointsToPixels(11) - stroke,
      5,
    );
    expect(Number.parseFloat(overlay.style["right"] ?? "")).toBeCloseTo(
      36 - pointsToPixels(2) - stroke,
      5,
    );
    expect(overlay.style["borderTopStyle"]).toBe("double");
    expect(overlay.style["borderTopWidth"]).toBe("3px");
  });

  test("display='firstPage' renders on page 1 and is skipped on page 2", () => {
    const onPage1 = renderWithBorders(makePage({ number: 1 }), {
      display: "firstPage",
      top: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
    });
    const onPage2 = renderWithBorders(makePage({ number: 2 }), {
      display: "firstPage",
      top: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
    });

    expect(borderOverlay(onPage1)).not.toBeNull();
    expect(borderOverlay(onPage2)).toBeNull();
  });

  test("display='notFirstPage' is skipped on page 1 and renders on page 2+", () => {
    const onPage1 = renderWithBorders(makePage({ number: 1 }), {
      display: "notFirstPage",
      top: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
    });
    const onPage3 = renderWithBorders(makePage({ number: 3 }), {
      display: "notFirstPage",
      top: { style: "single", size: 8, space: 24, color: { rgb: "000000" } },
    });

    expect(borderOverlay(onPage1)).toBeNull();
    expect(borderOverlay(onPage3)).not.toBeNull();
  });

  test("display='allPages' (default) renders on every page", () => {
    const onPage1 = renderWithBorders(makePage({ number: 1 }), {
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
    });
    const onPage5 = renderWithBorders(makePage({ number: 5 }), {
      display: "allPages",
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
    });

    expect(borderOverlay(onPage1)).not.toBeNull();
    expect(borderOverlay(onPage5)).not.toBeNull();
  });

  test("zOrder='back' inserts the overlay before content; zOrder='front' (default) inserts it after", () => {
    const backPage = renderWithBorders(makePage(), {
      zOrder: "back",
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
    });
    const frontPage = renderWithBorders(makePage(), {
      zOrder: "front",
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
    });

    const backIdx = backPage.children.findIndex((c) =>
      c.className.includes("layout-page-border"),
    );
    const frontIdx = frontPage.children.findIndex((c) =>
      c.className.includes("layout-page-border"),
    );
    expect(backIdx).toBe(0);
    expect(frontIdx).toBe(frontPage.children.length - 1);

    // z-index also encodes the layering for browsers that compute stacking
    // contexts (back behind content, front above content).
    const backOverlay = borderOverlay(backPage)!;
    const frontOverlay = borderOverlay(frontPage)!;
    expect(backOverlay.style["zIndex"]).toBe("0");
    expect(frontOverlay.style["zIndex"]).toBe("20");
  });

  test("per-side independence — each side keeps its own style/size/color/space", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 16, space: 4, color: { rgb: "FF0000" } },
      bottom: { style: "dashed", size: 8, space: 8, color: { rgb: "00FF00" } },
      left: { style: "double", size: 24, space: 12, color: { rgb: "0000FF" } },
      right: { style: "dotted", size: 4, space: 2, color: { rgb: "123456" } },
    });

    const overlay = borderOverlay(pageEl)!;
    expect(overlay.style["borderTopStyle"]).toBe("solid");
    expect(overlay.style["borderBottomStyle"]).toBe("dashed");
    expect(overlay.style["borderLeftStyle"]).toBe("double");
    expect(overlay.style["borderRightStyle"]).toBe("dotted");
    expect(overlay.style["borderTopColor"]?.toUpperCase()).toContain("FF0000");
    expect(overlay.style["borderBottomColor"]?.toUpperCase()).toContain(
      "00FF00",
    );
    expect(overlay.style["borderLeftColor"]?.toUpperCase()).toContain("0000FF");
    expect(overlay.style["borderRightColor"]?.toUpperCase()).toContain(
      "123456",
    );
  });

  test("none/nil sides are no-ops and do not contribute CSS", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
      bottom: { style: "none" },
      left: { style: "nil" },
    });

    const overlay = borderOverlay(pageEl)!;
    expect(overlay.style["borderTopStyle"]).toBe("solid");
    expect(overlay.style["borderBottomStyle"]).toBeUndefined();
    expect(overlay.style["borderLeftStyle"]).toBeUndefined();
    expect(overlay.style["borderRightStyle"]).toBeUndefined();
  });

  test("returns no overlay when every side is none/nil", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      display: "allPages",
      top: { style: "none" },
      bottom: { style: "nil" },
      left: { style: "none" },
      right: { style: "nil" },
    });

    expect(borderOverlay(pageEl)).toBeNull();
  });

  test("hairline (sz=2 = 0.25pt) is floored to a 1px stroke so it stays visible", () => {
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 2, space: 12, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl)!;
    expect(overlay.style["borderTopWidth"]).toBe("1px");
    expect(overlay.style["borderTopStyle"]).toBe("solid");
  });

  test("sz=0 with a printable style still emits a 1px hairline (Word fallback)", () => {
    // OOXML allows w:sz="0" to coexist with a non-nil style; matching the
    // existing `borderToStyle` behavior keeps these visible at common zoom
    // levels rather than collapsing them to nothing.
    const pageEl = renderWithBorders(makePage(), {
      offsetFrom: "page",
      top: { style: "single", size: 0, space: 12, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl)!;
    expect(overlay.style["borderTopWidth"]).toBe("1px");
  });

  test("respects offsetFrom default 'text' when offsetFrom is omitted", () => {
    const pageEl = renderWithBorders(makePage(), {
      top: { style: "single", size: 8, space: 12, color: { rgb: "000000" } },
    });

    const overlay = borderOverlay(pageEl)!;
    // top should be `max(0, margins.top - space - widthPx)` =
    // `54 - pointsToPixels(12) - eighthsToPixels(8)` (sz=8 = 1pt ≈ 1.333px).
    const strokeWidth = Math.max(1, eighthsToPixels(8));
    const expected = Math.max(0, 54 - pointsToPixels(12) - strokeWidth);
    expect(Number.parseFloat(overlay.style["top"] ?? "")).toBeCloseTo(
      expected,
      5,
    );
  });
});
