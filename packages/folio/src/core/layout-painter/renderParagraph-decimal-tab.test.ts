// Regression test for PR #512 gemini HIGH on renderParagraph.ts:1171.
//
// `renderLine` previously measured `decimalPrefixWidth` via
// `measureText(text)` without passing font size/family/style/scale, so the
// canvas fell back to 11px Calibri regardless of how the trailing run was
// formatted. Bold / sized / scaled text after a decimal tab was therefore
// anchored at the wrong position.
//
// The fix resolves the first text/field run after the tab and uses its
// fontSize, fontFamily, formatting style, and horizontalScale when
// measuring the prefix. This test asserts the tab span's painted width
// shrinks when the trailing run uses a larger font.

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

  // Font-size-aware canvas: width scales linearly with the px size embedded
  // in `font`. Falls back to 11px when no font is set (matches the painter's
  // `createTextMeasurer` default). This lets the test detect whether the
  // painter resolves the trailing run's font when measuring decimalPrefix.
  getContext(): {
    font: string;
    measureText: (text: string) => { width: number };
  } | null {
    if (this.tagName !== "canvas") {
      return null;
    }
    const ctx = {
      font: "",
      measureText(text: string): { width: number } {
        // Parse "<weight?> <px>px <family>" — grab the numeric pixel size.
        // eslint-disable-next-line sonarjs/slow-regex
        const match = /(\d+(?:\.\d+)?)px/u.exec(ctx.font);
        const fontSizePx = match ? Number(match[1]) : (11 * 96) / 72;
        // 1 char ≈ 0.5 em, so glyph width ≈ fontSizePx / 2.
        return { width: text.length * (fontSizePx / 2) };
      },
    };
    return ctx;
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

describe("renderLine — decimal tab respects trailing run font", () => {
  test("larger trailing fontSize shrinks the tab span width", () => {
    // Decimal stop at 3000 twips ≈ 200px. Leading text empty, trailing run
    // is "12.34" with two different font sizes. Prefix "12":
    //   - 11pt run → 14.67px → prefix width = 2 * (14.67/2) = 14.67px → tab ≈ 185.33px
    //   - 22pt run → 29.33px → prefix width = 2 * (29.33/2) = 29.33px → tab ≈ 170.67px
    // With the bug, both branches measure the prefix at 11px Calibri and
    // emit the same tab width.
    const tabStops: TabStop[] = [{ val: "decimal", pos: 3000 }];

    const renderAtSize = (fontSize: number): number => {
      const block: ParagraphBlock = {
        kind: "paragraph",
        id: `decimal-${fontSize}`,
        runs: [{ kind: "tab" }, { kind: "text", text: "12.34", fontSize }],
      };
      const line: MeasuredLine = {
        fromRun: 0,
        fromChar: 0,
        toRun: 1,
        toChar: 5,
        width: 400,
        ascent: 12,
        descent: 3,
        lineHeight: 15,
      };
      const lineEl = renderLine(block, line, undefined, fakeDocument, {
        availableWidth: 400,
        isLastLine: true,
        isFirstLine: true,
        paragraphEndsWithLineBreak: false,
        tabStops,
        leftIndentPx: 0,
      }) as unknown as FakeElement;

      const tabEl = findTabEl(lineEl);
      expect(tabEl).toBeDefined();
      const widthStr = tabEl?.style["width"] ?? "0px";
      return Number(widthStr.replace("px", ""));
    };

    const tab11 = renderAtSize(11);
    const tab22 = renderAtSize(22);

    // With the fix the prefix at 22pt is wider, so the tab span is narrower.
    // Gap should be at least ~10px on the test's deliberately exaggerated font
    // scale; allow generous slack so the assertion doesn't depend on the exact
    // measurement formula.
    expect(tab22).toBeLessThan(tab11 - 5);
  });

  test("bold trailing run is still measured (smoke test for run resolution)", () => {
    // Sanity: the painter resolves the trailing run even when formatting is
    // limited to bold/italic with no font size override. Both branches use
    // 11pt Calibri here, so widths match — the test mainly guards against a
    // regression where the new helper crashes or returns NaN on a bold run.
    const tabStops: TabStop[] = [{ val: "decimal", pos: 3000 }];

    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "decimal-bold",
      runs: [
        { kind: "tab" },
        { kind: "text", text: "1.5", bold: true, italic: true },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 1,
      toChar: 3,
      width: 400,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 400,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      tabStops,
      leftIndentPx: 0,
    }) as unknown as FakeElement;

    const tabEl = findTabEl(lineEl);
    expect(tabEl).toBeDefined();
    const widthStr = tabEl?.style["width"] ?? "0px";
    const width = Number(widthStr.replace("px", ""));
    expect(Number.isFinite(width)).toBe(true);
    expect(width).toBeGreaterThan(0);
  });
});
