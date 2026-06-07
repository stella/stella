import { describe, expect, test } from "bun:test";

import { clearTextWidthCache } from "../layout-engine/measure/cache";
import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import type {
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMeasure,
} from "../layout-engine/types";
import { AUTHOR_COLORS, resetAuthorColors } from "../utils/authorColors";
import { renderLine, renderParagraphFragment } from "./renderParagraph";

// Runtime shim: prod code calls element.style.setProperty("--doc-run-color", …)
// (real CSSStyleDeclaration has it); the mock stores it like any other prop so
// direct `style.color` access and `setProperty` both work. Typed as a plain
// Record so existing dot-access assertions stay valid.
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
  style: Record<string, string> = createFakeStyle();
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

    return {
      font: "",
      measureText(text: string) {
        return {
          width: text.length * 7 + (this.font.includes("800") ? 10 : 0),
        };
      },
    };
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

const TEST_HIGHLIGHT_COLOR = "#FFFF00";
const TEST_DARK_HIGHLIGHT_COLOR = "#000080";
const TEST_MID_HIGHLIGHT_COLOR = "#A9A9A9";
const TEST_EXPLICIT_BLACK_COLOR = " #000000 ";
const TEST_EXPLICIT_TEXT_COLOR = "#C00000";

describe("renderLine inline image handling", () => {
  test("pins image dimensions and centers an image-only line", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 186,
      height: 29,
      pmStart: 1,
      pmEnd: 2,
    };
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [imageRun],
      pmStart: 0,
      pmEnd: 3,
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 186,
      ascent: 32,
      descent: 3,
      lineHeight: 35,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const imageEl = lineEl.children[0] as HTMLElement | undefined;

    expect(lineEl.style.display).toBe("flex");
    expect(lineEl.style.alignItems).toBe("center");
    expect(imageEl?.style.width).toBe("186px");
    expect(imageEl?.style.height).toBe("29px");
  });

  // eigenpal #424 (image-crop subset): an inline image with crop fractions
  // must render the cropped slice scaled to the visible extent (wp:extent),
  // not just clipped. A naive `clip-path: inset(...)` leaves the bitmap at
  // extent size, so the wrong region shows surrounded by blank bands. The
  // painter wraps the `<img>` in an overflow-hidden inline-block sized to
  // the visible extent and upscales the inner `<img>` by 1/(1-l-r) × 1/(1-t-b).
  // Regression: gemini-code-assist + chatgpt-codex review on PR #510.
  test("wraps a cropped inline image and scales the inner <img>", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 100,
      // Remaining fractions: width 1 - 0.15 - 0.2 = 0.65 → fw ≈ 1.5384615
      // height 1 - 0.1 - 0.05 = 0.85 → fh ≈ 1.1764706
      cropTop: 0.1,
      cropRight: 0.2,
      cropBottom: 0.05,
      cropLeft: 0.15,
      pmStart: 1,
      pmEnd: 2,
    };
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p-crop",
      runs: [imageRun],
      pmStart: 0,
      pmEnd: 3,
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 100,
      ascent: 32,
      descent: 3,
      lineHeight: 35,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapperEl = lineEl.children[0] as FakeElement | undefined;

    // Wrapper: sized to visible extent, overflow-hidden, inline-block so it
    // flows with text and clips the upscaled inner bitmap.
    expect(wrapperEl?.tagName).toBe("span");
    expect(wrapperEl?.style.display).toBe("inline-block");
    expect(wrapperEl?.style.overflow).toBe("hidden");
    expect(wrapperEl?.style.width).toBe("100px");
    expect(wrapperEl?.style.height).toBe("100px");

    const imgEl = wrapperEl?.children[0] as FakeElement | undefined;
    expect(imgEl?.tagName).toBe("img");
    // The inner <img> is enlarged so the cropped region exactly covers the
    // wrapper, with negative margins shifting the bitmap so the cropped
    // top-left lands at the wrapper's origin. `object-fit: fill` keeps the
    // bitmap stretched (no contain letterboxing) inside the enlarged box.
    // FP precision: the painter computes 1/(1-l-r) where l+r is FP-noisy, so
    // assert with a numeric tolerance on the parsed percent rather than the
    // exact decimal expansion.
    const widthPct = Number.parseFloat(imgEl?.style.width ?? "");
    const heightPct = Number.parseFloat(imgEl?.style.height ?? "");
    const marginLeftPct = Number.parseFloat(imgEl?.style.marginLeft ?? "");
    const marginTopPct = Number.parseFloat(imgEl?.style.marginTop ?? "");
    expect(widthPct).toBeCloseTo((1 / 0.65) * 100, 6);
    expect(heightPct).toBeCloseTo((1 / 0.85) * 100, 6);
    expect(marginLeftPct).toBeCloseTo((-0.15 / 0.65) * 100, 6);
    expect(marginTopPct).toBeCloseTo((-0.1 / 0.85) * 100, 6);
    expect(imgEl?.style.objectFit).toBe("fill");
    // The legacy clip-path approach must not be used.
    expect(imgEl?.style.clipPath).toBeFalsy();
    expect(wrapperEl?.style.clipPath).toBeFalsy();
  });

  // Pathological crops (e.g. cropLeft + cropRight ≥ 1) would otherwise divide
  // by zero or render a negatively-sized image. The painter falls back to no
  // crop transform so the bitmap is at least visible.
  test("falls back to unscaled image when crop leaves no visible area", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 80,
      height: 80,
      cropLeft: 0.6,
      cropRight: 0.6,
      pmStart: 1,
      pmEnd: 2,
    };
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p-degenerate",
      runs: [imageRun],
      pmStart: 0,
      pmEnd: 3,
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 80,
      ascent: 32,
      descent: 3,
      lineHeight: 35,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapperEl = lineEl.children[0] as FakeElement | undefined;
    const imgEl = wrapperEl?.children[0] as FakeElement | undefined;

    // Wrapper still exists (hasImageVisualAttrs was truthy), but the inner
    // <img> keeps its 100%/100% sizing instead of an upscale-by-infinity.
    expect(imgEl?.style.width).toBe("100%");
    expect(imgEl?.style.height).toBe("100%");
    expect(imgEl?.style.marginLeft).toBeFalsy();
    expect(imgEl?.style.marginTop).toBeFalsy();
  });

  test("does not wrap or transform when no crop is set", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 100,
      pmStart: 1,
      pmEnd: 2,
    };
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p-nocrop",
      runs: [imageRun],
      pmStart: 0,
      pmEnd: 3,
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 100,
      ascent: 32,
      descent: 3,
      lineHeight: 35,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const imageEl = lineEl.children[0] as FakeElement | undefined;

    // Without crop the painter inserts the raw `<img>` directly into the
    // line, with no wrapper and no clip-path / transform leakage.
    expect(imageEl?.tagName).toBe("img");
    expect(imageEl?.style.clipPath).toBeFalsy();
  });

  // Regression chatgpt-codex on #410: the image+text flex branch fired on
  // `runsForLine.some(isImageRun)`, which also matched FLOATING images. Those
  // render in a page-level layer and `continue` in the main loop, so a line
  // that wraps around a floating image (text-only inline content) was being
  // forced into flex/baseline layout — changing alignment + indent + line
  // height for normal body text. Must be gated to non-floating images.
  test("does not flex-promote a line whose only image is floating", () => {
    const floatingImage: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 80,
      displayMode: "float",
      wrapType: "square",
      pmStart: 1,
      pmEnd: 2,
    };
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "wrap-around-float",
      runs: [floatingImage, { kind: "text", text: "Body text wrapping" }],
      pmStart: 0,
      pmEnd: 20,
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 1,
      toChar: 18,
      width: 400,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);

    // The line still contains an ImageRun in its run slice, but it's
    // floating — flex promotion must not fire.
    expect(lineEl.style.display).not.toBe("flex");
    expect(lineEl.style.alignItems).not.toBe("baseline");
  });
});

describe("renderLine scaled text handling", () => {
  test("reserves scaled advance for horizontally scaled text runs", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "abcd",
          horizontalScale: 150,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 4,
      width: 42,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.transform).toBe("scaleX(1.5)");
    expect(textEl?.style.width).toBe("42px");
  });
});

describe("renderLine text styling", () => {
  test("paints DOCX bold runs with the calibrated browser weight", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "SECURITIES ACT",
          bold: true,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 14,
      width: 80,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.fontWeight).toBe("800");
  });

  test("keeps automatic text readable on bright DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#000000");
  });

  test("keeps automatic text readable on dark DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_DARK_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#FFFFFF");
  });

  test("keeps inherited default-black text readable on dark DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          color: TEST_EXPLICIT_BLACK_COLOR,
          textColorSource: "paragraphDefault",
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_DARK_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#FFFFFF");
  });

  test("keeps automatic hyperlink text readable on dark DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
          hyperlink: { href: "https://example.com" },
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;
    const anchorEl = textEl?.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_DARK_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#FFFFFF");
    expect(anchorEl?.style.color).toBe("#FFFFFF");
  });

  test("keeps inherited default-black hyperlink text readable on dark DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          color: TEST_EXPLICIT_BLACK_COLOR,
          textColorSource: "paragraphDefault",
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
          hyperlink: { href: "https://example.com" },
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;
    const anchorEl = textEl?.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_DARK_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#FFFFFF");
    expect(anchorEl?.style.color).toBe("#FFFFFF");
  });

  test("preserves direct black hyperlink text without DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Linked text",
          color: TEST_EXPLICIT_BLACK_COLOR,
          textColorSource: "direct",
          hyperlink: { href: "https://example.com" },
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 11,
      width: 77,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;
    const anchorEl = textEl?.children[0] as HTMLElement | undefined;

    expect(textEl?.style.color).toBe("#000000");
    expect(anchorEl?.style.color).toBe("#000000");
  });

  test("uses Word blue for inherited default-black hyperlink text without DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Linked text",
          color: TEST_EXPLICIT_BLACK_COLOR,
          textColorSource: "paragraphDefault",
          hyperlink: { href: "https://example.com" },
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 11,
      width: 77,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;
    const anchorEl = textEl?.children[0] as HTMLElement | undefined;

    expect(textEl?.style.color).toBe("#0563c1");
    expect(anchorEl?.style.color).toBe("#0563c1");
    // The anchor paints over the span, so it must carry --doc-run-color for the
    // dark-mode inversion rule to reach it (otherwise links stay dim on dark).
    expect(anchorEl?.style.getPropertyValue("--doc-run-color")).toBe("#0563c1");
  });

  test("uses the higher-contrast text color on mid-tone DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_MID_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_MID_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#000000");
  });

  test("keeps automatic comment text readable when comment styling overrides a DOCX highlight", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
          commentIds: [42],
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe("rgba(255, 212, 0, 0.08)");
    expect(textEl?.style.color).toBeUndefined();
    expect(textEl?.dataset.commentId).toBe("42");
  });

  test("preserves explicit text colors on DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          color: TEST_EXPLICIT_TEXT_COLOR,
          highlight: TEST_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe(TEST_EXPLICIT_TEXT_COLOR);
  });

  test("exposes explicit run color as --doc-run-color for dark-mode inversion", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        { kind: "text", text: "Colored", color: TEST_EXPLICIT_TEXT_COLOR },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 7,
      width: 50,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    // Inline color is kept verbatim (light mode); the custom property lets the
    // dark-mode CSS invert lightness while preserving hue/chroma.
    expect(textEl?.style.color).toBe(TEST_EXPLICIT_TEXT_COLOR);
    expect(textEl?.style.getPropertyValue("--doc-run-color")).toBe(
      TEST_EXPLICIT_TEXT_COLOR,
    );
  });

  test("preserves explicit black text colors on DOCX highlights", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          color: TEST_EXPLICIT_BLACK_COLOR,
          highlight: TEST_DARK_HIGHLIGHT_COLOR,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_DARK_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe("#000000");
  });

  test("preserves tracked-change author colors on DOCX highlights", () => {
    resetAuthorColors();
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        {
          kind: "text",
          text: "Highlighted text",
          highlight: TEST_HIGHLIGHT_COLOR,
          isInsertion: true,
          changeAuthor: "Reviewer",
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 16,
      width: 112,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const textEl = lineEl.children[0] as HTMLElement | undefined;

    expect(textEl?.style.backgroundColor).toBe(TEST_HIGHLIGHT_COLOR);
    expect(textEl?.style.color).toBe(AUTHOR_COLORS[0]);
  });
});

describe("renderLine tab tracking", () => {
  test("measures preceding bold text with the rendered DOCX bold weight", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        { kind: "text", text: "AA", bold: true },
        { kind: "tab" },
        { kind: "text", text: "B" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 55,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const tabEl = lineEl.children[1] as HTMLElement | undefined;

    expect(tabEl?.style.width).toBe("24px");
  });

  test("includes preceding run letter spacing when sizing tabs", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [
        { kind: "text", text: "AA", letterSpacing: 10 },
        { kind: "tab" },
        { kind: "text", text: "B" },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 2,
      toChar: 1,
      width: 55,
      ascent: 10,
      descent: 2,
      lineHeight: 12,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const tabEl = lineEl.children[1] as HTMLElement | undefined;

    expect(tabEl?.style.width).toBe("24px");
  });
});

describe("renderParagraphFragment indentation handling", () => {
  test("renders list marker revisions with tracked-change classes", () => {
    resetAuthorColors();
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [{ kind: "text", text: "Item" }],
      attrs: {
        listMarker: "1.",
        listMarkerRevision: {
          kind: "ins",
          author: "Reviewer",
          date: "2026-01-01",
          revisionId: 12,
        },
      },
    };
    const measure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 4,
          width: 28,
          ascent: 10,
          descent: 2,
          lineHeight: 12,
        },
      ],
      totalHeight: 12,
    };
    const fragment: ParagraphFragment = {
      kind: "paragraph",
      blockId: "p1",
      x: 0,
      y: 0,
      width: 100,
      height: 12,
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
    let fragmentEl: HTMLElement;
    try {
      fragmentEl = renderParagraphFragment(
        fragment,
        block,
        measure,
        { pageNumber: 1, totalPages: 1, section: "body" },
        { document: fakeDocument },
      );
    } finally {
      clearTextWidthCache();
      resetCanvasContext();
      Object.defineProperty(globalThis, "document", {
        value: originalDocument,
        configurable: true,
      });
    }
    const lineEl = fragmentEl.children[0] as HTMLElement | undefined;
    const markerEl = lineEl?.children[0] as HTMLElement | undefined;

    expect(markerEl?.className).toContain("layout-list-marker");
    expect(markerEl?.className).toContain("docx-insertion");
    expect(markerEl?.style.color).toBe(AUTHOR_COLORS[0]);
    expect(markerEl?.style.textDecorationLine).toBe("underline");
    expect(markerEl?.dataset["tcAuthorIdx"]).toBe("0");
    expect(markerEl?.dataset["changeAuthor"]).toBe("Reviewer");
  });

  test("negative side indents shift and widen line boxes", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      runs: [{ kind: "text", text: "wide" }],
      attrs: {
        indent: {
          left: -20,
          right: -10,
        },
      },
    };
    const measure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 4,
          width: 20,
          ascent: 10,
          descent: 2,
          lineHeight: 12,
        },
      ],
      totalHeight: 12,
    };
    const fragment: ParagraphFragment = {
      kind: "paragraph",
      blockId: "p1",
      x: 0,
      y: 0,
      width: 100,
      height: 12,
      fromLine: 0,
      toLine: 1,
    };

    const fragmentEl = renderParagraphFragment(
      fragment,
      block,
      measure,
      { pageNumber: 1, totalPages: 1, section: "body" },
      { document: fakeDocument },
    );
    const lineEl = fragmentEl.children[0] as HTMLElement | undefined;

    expect(lineEl?.style.marginLeft).toBe("-20px");
    expect(lineEl?.style.width).toBe("130px");
  });
});
