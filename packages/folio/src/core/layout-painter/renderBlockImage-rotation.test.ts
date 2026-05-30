/**
 * Block-image rotation bbox tests.
 *
 * Ports the gap-8 block path from eigenpal/docx-editor #424
 * (commit c605277c9): rotated block images must reserve an
 * axis-aligned bounding box on their container so they don't
 * bleed into the next paragraph. Un-rotated block images keep
 * the fast path.
 *
 * Companion to the inline path covered in
 * `renderImage-rotation.test.ts` (folio PR #518).
 */

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

function makeBlockImageLine(image: ImageRun): {
  block: ParagraphBlock;
  line: MeasuredLine;
} {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id: "p1",
    runs: [image],
    pmStart: 0,
    pmEnd: 3,
  };
  const line: MeasuredLine = {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 1,
    width: image.width,
    ascent: image.height,
    descent: 3,
    lineHeight: image.height + 3,
  };
  return { block, line };
}

describe("block image rotation bbox container", () => {
  test("wraps a 90deg rotated block image with bbox height + absolute centering", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "rotate(90deg)",
      pmStart: 1,
      pmEnd: 2,
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.tagName).toBe("div");
    expect(container.className).toContain("layout-block-image");
    expect(container.style["position"]).toBe("relative");
    // 90deg swaps the dims exactly (no FP drift): bboxH = original width.
    expect(container.style["height"]).toBe("100px");

    const imgEl = container.children[0] as unknown as FakeElement;
    expect(imgEl.tagName).toBe("img");
    expect(imgEl.style["transform"]).toBe("rotate(90deg)");
    expect(imgEl.style["transformOrigin"]).toBe("center center");
    expect(imgEl.style["position"]).toBe("absolute");
    expect(imgEl.style["left"]).toBe("50%");
    expect(imgEl.style["top"]).toBe("50%");
    expect(imgEl.style["marginLeft"]).toBe(`${-imageRun.width / 2}px`);
    expect(imgEl.style["marginTop"]).toBe(`${-imageRun.height / 2}px`);
    expect(imgEl.style["marginRight"]).toBe("0");
  });

  test("wraps a 270deg rotated block image with the height set to original width", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 120,
      height: 60,
      displayMode: "block",
      transform: "rotate(270deg)",
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.tagName).toBe("div");
    expect(container.style["height"]).toBe("120px");
    expect(container.style["position"]).toBe("relative");
  });

  test("wraps a 45deg rotated block image with the standard |cos|+|sin| height", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "rotate(45deg)",
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    // At 45deg, |sin| = |cos|. bboxH = w*|sin| + h*|cos|.
    // Compute via the same trig calls the implementation uses to avoid FP
    // drift between `Math.sin(pi/4) + Math.cos(pi/4)` and `Math.SQRT2`.
    const rad = (45 * Math.PI) / 180;
    const sinA = Math.abs(Math.sin(rad));
    const cosA = Math.abs(Math.cos(rad));
    const expectedH = 100 * sinA + 200 * cosA;
    expect(container.style["height"]).toBe(`${expectedH}px`);
    expect(container.style["position"]).toBe("relative");

    const imgEl = container.children[0] as unknown as FakeElement;
    expect(imgEl.style["position"]).toBe("absolute");
  });

  test("does NOT add bbox container styles to an un-rotated block image", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      pmStart: 1,
      pmEnd: 2,
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.tagName).toBe("div");
    expect(container.style["position"]).not.toBe("relative");
    expect(container.style["height"]).toBeUndefined();

    const imgEl = container.children[0] as unknown as FakeElement;
    expect(imgEl.tagName).toBe("img");
    expect(imgEl.style["position"]).not.toBe("absolute");
    // Fast path: centered via auto margins, not absolute positioning.
    expect(imgEl.style["marginLeft"]).toBe("auto");
    expect(imgEl.style["marginRight"]).toBe("auto");
  });

  test("does NOT add bbox container styles to a 0deg rotated block image", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "rotate(0deg)",
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.tagName).toBe("div");
    expect(container.style["position"]).not.toBe("relative");
    expect(container.style["height"]).toBeUndefined();
  });

  test("does NOT add bbox container styles to a flip-only block image", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "scaleX(-1) scaleY(-1)",
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.style["position"]).not.toBe("relative");
    expect(container.style["height"]).toBeUndefined();

    const imgEl = container.children[0] as unknown as FakeElement;
    expect(imgEl.style["transform"]).toBe("scaleX(-1) scaleY(-1)");
    expect(imgEl.style["position"]).not.toBe("absolute");
  });

  test("sets transformOrigin: center center on every block-image transform (rotated or not)", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "scaleX(-1)",
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;
    const imgEl = container.children[0] as unknown as FakeElement;

    expect(imgEl.style["transformOrigin"]).toBe("center center");
  });

  test("threads pmStart/pmEnd onto the container so PM positions stay attached after wrapping", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      displayMode: "block",
      transform: "rotate(90deg)",
      pmStart: 7,
      pmEnd: 8,
    };
    const { block, line } = makeBlockImageLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const container = lineEl.children[0] as unknown as FakeElement;

    expect(container.dataset["pmStart"]).toBe("7");
    expect(container.dataset["pmEnd"]).toBe("8");
  });
});
