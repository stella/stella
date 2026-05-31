import { describe, expect, test } from "bun:test";

import type { MeasuredLine, ParagraphBlock } from "../layout-engine/types";
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

function findTabEl(lineEl: FakeElement): FakeElement | undefined {
  return lineEl.children.find((child) =>
    child.className.includes("layout-run-tab"),
  );
}

describe("renderLine box model", () => {
  test("uses content-box and visible overflow so highlighted text is not clipped", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "highlighted-placeholder",
      runs: [
        {
          kind: "text",
          text: "COMPANY NAME",
          highlight: "yellow",
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: "COMPANY NAME".length,
      width: 100,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 360,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      leftIndentPx: 288,
    }) as unknown as FakeElement;

    expect(lineEl.style["boxSizing"]).toBe("content-box");
    expect(lineEl.style["overflow"]).toBe("visible");
  });

  test("renders underlined tabs as a continuous rule without a text underline mark", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "signature-line",
      runs: [
        { kind: "text", text: "By:" },
        { kind: "tab", underline: { style: "single" } },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 1,
      toChar: 1,
      width: 200,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 360,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      leftIndentPx: 0,
    }) as unknown as FakeElement;

    const tabEl = findTabEl(lineEl);
    expect(tabEl).toBeDefined();
    expect(tabEl?.style["borderBottom"]).toBe("1px solid currentColor");
    expect(tabEl?.style["textDecorationLine"]).toBe("");
  });

  test("does not underline raised footnote reference markers", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "footnote-marker",
      runs: [
        {
          kind: "text",
          text: "9",
          footnoteRefId: 9,
          superscript: true,
          underline: { style: "single" },
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 10,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 360,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      leftIndentPx: 0,
    }) as unknown as FakeElement;
    const noteMarker = lineEl.children.at(0);

    expect(noteMarker?.style["verticalAlign"]).toBe("super");
    expect(noteMarker?.style["textDecorationLine"]).toBeUndefined();
  });

  test("sizes superscript markers from the run font instead of the parent line", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "footnote-marker",
      runs: [
        {
          kind: "text",
          text: "8",
          fontFamily: "Times New Roman",
          fontSize: 10,
          superscript: true,
        },
      ],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 1,
      width: 10,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 360,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      leftIndentPx: 0,
    }) as unknown as FakeElement;
    const noteMarker = lineEl.children.at(0);

    expect(noteMarker?.style["verticalAlign"]).toBe("super");
    expect(noteMarker?.style["fontFamily"]).toContain("Times New Roman");
    expect(noteMarker?.style["fontSize"]).toBe("10px");
  });

  test("renders underlined whitespace as a rule segment", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "underlined-space",
      runs: [{ kind: "text", text: "  ", underline: { style: "single" } }],
    };
    const line: MeasuredLine = {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 2,
      width: 20,
      ascent: 12,
      descent: 3,
      lineHeight: 15,
    };

    const lineEl = renderLine(block, line, undefined, fakeDocument, {
      availableWidth: 360,
      isLastLine: true,
      isFirstLine: true,
      paragraphEndsWithLineBreak: false,
      leftIndentPx: 0,
    }) as unknown as FakeElement;
    const space = lineEl.children.at(0);

    expect(space?.style["borderBottom"]).toBe("1px solid currentColor");
    expect(space?.style["textDecorationLine"]).toBe("");
  });
});
