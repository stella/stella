/**
 * Regression tests — keep dense footnotes inside the page bottom.
 *
 * Ports the upstream defect surfaced in eigenpal/docx-editor#485: when the
 * paginator under-reserves space for the footnote area (off by a few pixels
 * on densely stacked footnotes), the painted area extended past the page
 * bottom. The fix clamps `reservedHeight` to the painter's calculated area
 * height and clamps the resulting `top` so the area never escapes the page
 * vertically.
 */

import { describe, expect, test } from "bun:test";

import { calculateFootnoteReservedHeights } from "../layout-bridge/footnoteLayout";
import { FOOTNOTE_SEPARATOR_HEIGHT as PAGINATOR_FOOTNOTE_SEPARATOR_HEIGHT } from "../layout-engine/paginator";
import type {
  Page,
  ParagraphBlock,
  ParagraphMeasure,
} from "../layout-engine/types";
import { FOOTNOTE_SEPARATOR_HEIGHT } from "../layout-engine/types";
import {
  calculateFootnoteAreaRenderHeight,
  renderPage,
  type FootnoteRenderItem,
} from "../layout-painter/renderPage";

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

function findByClass(
  element: FakeElement,
  className: string,
): FakeElement | undefined {
  if (element.className.split(" ").includes(className)) {
    return element;
  }
  for (const child of element.children) {
    const found = findByClass(child, className);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function makeParagraphFootnote(height: number): FootnoteRenderItem {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: `fn-${height}`,
    runs: [{ kind: "text", text: "fn" }],
  };
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    lines: [
      {
        fromRun: 0,
        fromChar: 0,
        toRun: 0,
        toChar: 2,
        width: 12,
        ascent: 8,
        descent: 2,
        lineHeight: height,
      },
    ],
    totalHeight: height,
  };
  return {
    displayNumber: "1",
    content: { blocks: [block], measures: [measure], height },
  };
}

const basePage: Page = {
  number: 1,
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
  size: { w: 816, h: 1056 },
  fragments: [],
};

// Painter constants mirrored in `calculateFootnoteAreaRenderHeight`. Kept
// local to the test so a drift between painter/helper fails here before it
// fails in production. See `renderPage.ts` for the source values.
const PAINTER_FOOTNOTE_ENTRY_MARGIN_BOTTOM = 0;
const PAINTER_FOOTNOTE_FALLBACK_LINE_HEIGHT = 13;

describe("calculateFootnoteAreaRenderHeight", () => {
  test("returns separator height when no footnote has measured content", () => {
    expect(calculateFootnoteAreaRenderHeight([])).toBe(
      FOOTNOTE_SEPARATOR_HEIGHT,
    );
  });

  test("sums each footnote content height plus any wrapper margin and a single separator", () => {
    const footnotes: FootnoteRenderItem[] = [
      makeParagraphFootnote(20),
      makeParagraphFootnote(35),
      makeParagraphFootnote(15),
    ];
    expect(calculateFootnoteAreaRenderHeight(footnotes)).toBe(
      FOOTNOTE_SEPARATOR_HEIGHT +
        20 +
        35 +
        15 +
        3 * PAINTER_FOOTNOTE_ENTRY_MARGIN_BOTTOM,
    );
  });

  test("counts fallback line height for footnotes without measured content", () => {
    const footnotes: FootnoteRenderItem[] = [
      { displayNumber: "1", text: "plain" },
      makeParagraphFootnote(40),
    ];
    expect(calculateFootnoteAreaRenderHeight(footnotes)).toBe(
      FOOTNOTE_SEPARATOR_HEIGHT +
        PAINTER_FOOTNOTE_FALLBACK_LINE_HEIGHT +
        40 +
        2 * PAINTER_FOOTNOTE_ENTRY_MARGIN_BOTTOM,
    );
  });
});

describe("renderFootnoteArea overflow clamp", () => {
  test("uses the under-reserved height verbatim when content fits within the reservation", () => {
    const reserved = 200;
    const fn = makeParagraphFootnote(50);
    const pageEl = renderPage(
      { ...basePage, footnoteReservedHeight: reserved, fragments: [] },
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument, footnoteArea: [fn] },
    ) as unknown as FakeElement;

    const fnAreaEl = findByClass(pageEl, "layout-footnote-area");
    expect(fnAreaEl).toBeDefined();
    const top = Number.parseFloat(fnAreaEl?.style["top"] ?? "0");
    const contentAreaBottom =
      basePage.size.h - basePage.margins.bottom - basePage.margins.top;
    expect(top).toBeCloseTo(contentAreaBottom - reserved, 5);
  });

  test("clamps reservedHeight upward when the painter would draw a taller area", () => {
    // Paginator under-reserved by 60 px. Painted area must still start
    // high enough so its bottom never exceeds the page content bottom.
    const fnHeights = [40, 50, 60];
    const footnotes = fnHeights.map(makeParagraphFootnote);
    const reservedTooSmall = 20;
    const pageEl = renderPage(
      {
        ...basePage,
        footnoteReservedHeight: reservedTooSmall,
        fragments: [],
      },
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument, footnoteArea: footnotes },
    ) as unknown as FakeElement;

    const fnAreaEl = findByClass(pageEl, "layout-footnote-area");
    expect(fnAreaEl).toBeDefined();
    const top = Number.parseFloat(fnAreaEl?.style["top"] ?? "0");
    const contentAreaBottom =
      basePage.size.h - basePage.margins.bottom - basePage.margins.top;
    const calculated = calculateFootnoteAreaRenderHeight(footnotes);
    expect(calculated).toBeGreaterThan(reservedTooSmall);
    expect(top).toBeCloseTo(contentAreaBottom - calculated, 5);
  });

  test("clamps top so the area never escapes above the page (negative top margin floor)", () => {
    // Build a footnote stack taller than the entire content area so the
    // calculated render height exceeds the body. The top is clamped to
    // `-page.margins.top` so the area stays anchored to the page.
    const contentAreaHeight =
      basePage.size.h - basePage.margins.top - basePage.margins.bottom;
    const oversized = contentAreaHeight + 500;
    const fn = makeParagraphFootnote(oversized);
    const pageEl = renderPage(
      { ...basePage, footnoteReservedHeight: 0, fragments: [] },
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument, footnoteArea: [fn] },
    ) as unknown as FakeElement;

    const fnAreaEl = findByClass(pageEl, "layout-footnote-area");
    expect(fnAreaEl).toBeDefined();
    const top = Number.parseFloat(fnAreaEl?.style["top"] ?? "0");
    expect(top).toBe(-basePage.margins.top);
  });
});

describe("footnote separator height parity", () => {
  test("painter render height matches paginator reservation for 1, 3, and 10 footnotes", () => {
    // Paginator reserves separator + sum(content) + any wrapper margin. The
    // wrapper margin is zero for Word-like footnote spacing, but keep the
    // parity assertion so a future nonzero value stays accounted for.
    for (const count of [1, 3, 10]) {
      const heights = Array.from({ length: count }, (_, index) => 10 + index);
      const footnotes = heights.map(makeParagraphFootnote);
      const painterHeight = calculateFootnoteAreaRenderHeight(footnotes);
      const paginatorHeight =
        heights.reduce((sum, height) => sum + height, 0) +
        PAGINATOR_FOOTNOTE_SEPARATOR_HEIGHT;
      expect(painterHeight).toBe(
        paginatorHeight + count * PAINTER_FOOTNOTE_ENTRY_MARGIN_BOTTOM,
      );
    }
  });

  test("static `calculateFootnoteReservedHeights` matches painter render height", () => {
    // Bot raised: the static reservation path under-counted by
    // `count × marginBottom`, so the painter's clamp would shift the
    // area upward and overlap body lines. Assert the static helper
    // now matches the painter for 1, 3, and 10 dense footnotes.
    for (const count of [1, 3, 10]) {
      const heights = Array.from({ length: count }, (_, index) => 10 + index);
      const footnoteIds = heights.map((_, index) => index + 1);
      const footnotes: FootnoteRenderItem[] = heights.map(
        makeParagraphFootnote,
      );
      const pageFootnoteMap = new Map<number, number[]>([[1, footnoteIds]]);
      const contentMap = new Map(
        footnoteIds.map((id, index) => [id, { height: heights[index] ?? 0 }]),
      );

      const reserved =
        calculateFootnoteReservedHeights(pageFootnoteMap, contentMap).get(1) ??
        0;
      const painterHeight = calculateFootnoteAreaRenderHeight(footnotes);
      expect(reserved).toBe(painterHeight);
    }
  });

  test("painter separator margins derive from FOOTNOTE_SEPARATOR_HEIGHT so paint equals measurement", () => {
    const fn = makeParagraphFootnote(20);
    const pageEl = renderPage(
      { ...basePage, footnoteReservedHeight: 100, fragments: [] },
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument, footnoteArea: [fn] },
    ) as unknown as FakeElement;

    const fnAreaEl = findByClass(pageEl, "layout-footnote-area");
    expect(fnAreaEl).toBeDefined();
    const separator = fnAreaEl?.children.at(0);
    expect(separator).toBeDefined();

    const rule = Number.parseFloat(separator?.style["height"] ?? "0");
    const marginTop = Number.parseFloat(separator?.style["marginTop"] ?? "0");
    const marginBottom = Number.parseFloat(
      separator?.style["marginBottom"] ?? "0",
    );
    expect(rule + marginTop + marginBottom).toBeCloseTo(
      FOOTNOTE_SEPARATOR_HEIGHT,
      5,
    );
  });
});
