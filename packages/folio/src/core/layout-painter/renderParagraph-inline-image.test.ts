import { describe, expect, test } from "bun:test";

import type {
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
} from "../layout-engine/types";
import { renderLine } from "./renderParagraph";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  innerHTML = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
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

  getContext(): null {
    return null;
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

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
