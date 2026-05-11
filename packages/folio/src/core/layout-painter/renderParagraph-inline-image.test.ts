import { describe, expect, test } from "bun:test";

import type {
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
  ParagraphFragment,
  ParagraphMeasure,
} from "../layout-engine/types";
import { AUTHOR_COLORS, resetAuthorColors } from "../utils/authorColors";
import { renderLine, renderParagraphFragment } from "./renderParagraph";

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
