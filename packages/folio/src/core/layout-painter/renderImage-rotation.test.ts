/**
 * Inline-image rotation bbox tests.
 *
 * Ports the gap-8 follow-up from eigenpal/docx-editor #424
 * (commit c605277c9): rotated inline images must reserve an
 * axis-aligned bounding box so they don't clip into the
 * adjacent line. Un-rotated images keep the fast path.
 */

import { describe, expect, test } from "bun:test";

import type {
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
} from "../layout-engine/types";
import {
  inlineImageBoundingBox,
  parseRotationDegrees,
} from "../utils/rotationBoundingBox";
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

function makeImageOnlyLine(image: ImageRun): {
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

describe("inline image rotation bbox wrapper", () => {
  test("wraps a 90deg rotated image in an inline-block bbox with the dims swapped", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "rotate(90deg)",
      pmStart: 1,
      pmEnd: 2,
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapper = lineEl.children[0] as unknown as FakeElement;

    expect(wrapper.tagName).toBe("span");
    expect(wrapper.style["display"]).toBe("inline-block");
    expect(wrapper.style["position"]).toBe("relative");
    expect(wrapper.style["verticalAlign"]).toBe("middle");
    // 90deg swaps the dims exactly (no FP drift).
    expect(wrapper.style["width"]).toBe("200px");
    expect(wrapper.style["height"]).toBe("100px");

    const imgEl = wrapper.children[0] as unknown as FakeElement;
    expect(imgEl.tagName).toBe("img");
    expect(imgEl.style["position"]).toBe("absolute");
    expect(imgEl.style["transform"]).toBe("rotate(90deg)");
    // Center the unrotated img inside the rotated bbox:
    // left = (bboxW - w) / 2 = (200 - 100) / 2 = 50
    // top  = (bboxH - h) / 2 = (100 - 200) / 2 = -50
    expect(imgEl.style["left"]).toBe("50px");
    expect(imgEl.style["top"]).toBe("-50px");
    expect(imgEl.style["width"]).toBe("100px");
    expect(imgEl.style["height"]).toBe("200px");
  });

  test("wraps a 270deg rotated image with dims swapped", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 120,
      height: 60,
      transform: "rotate(270deg)",
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapper = lineEl.children[0] as unknown as FakeElement;

    expect(wrapper.tagName).toBe("span");
    expect(wrapper.style["width"]).toBe("60px");
    expect(wrapper.style["height"]).toBe("120px");
  });

  test("wraps a 45deg rotated image with the standard |cos|+|sin| bbox", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "rotate(45deg)",
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapper = lineEl.children[0] as unknown as FakeElement;

    expect(wrapper.tagName).toBe("span");
    // At 45deg, |sin| = |cos|. bboxW = w*|cos| + h*|sin|, bboxH symmetric.
    // Compute via the same trig calls the implementation uses to avoid FP
    // drift between `Math.sin(pi/4) + Math.cos(pi/4)` and `Math.SQRT2`.
    const rad = (45 * Math.PI) / 180;
    const sinA = Math.abs(Math.sin(rad));
    const cosA = Math.abs(Math.cos(rad));
    const expectedW = 100 * cosA + 200 * sinA;
    const expectedH = 100 * sinA + 200 * cosA;
    expect(wrapper.style["width"]).toBe(`${expectedW}px`);
    expect(wrapper.style["height"]).toBe(`${expectedH}px`);

    const imgEl = wrapper.children[0] as unknown as FakeElement;
    expect(imgEl.style["position"]).toBe("absolute");
    expect(imgEl.style["left"]).toBe(`${(expectedW - 100) / 2}px`);
    expect(imgEl.style["top"]).toBe(`${(expectedH - 200) / 2}px`);
  });

  test("does NOT wrap an un-rotated image (no transform)", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      pmStart: 1,
      pmEnd: 2,
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const direct = lineEl.children[0] as unknown as FakeElement;

    // Fast path: the rendered element is the <img> itself, no <span> wrapper.
    expect(direct.tagName).toBe("img");
    expect(direct.style["position"]).not.toBe("absolute");
    expect(direct.style["width"]).toBe("100px");
    expect(direct.style["height"]).toBe("200px");
  });

  test("does NOT wrap an image with a 0deg rotation transform", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "rotate(0deg)",
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const direct = lineEl.children[0] as unknown as FakeElement;

    expect(direct.tagName).toBe("img");
    expect(direct.style["position"]).not.toBe("absolute");
  });

  test("does NOT wrap a flip-only image (scaleX/scaleY, no rotate)", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "scaleX(-1) scaleY(-1)",
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const direct = lineEl.children[0] as unknown as FakeElement;

    expect(direct.tagName).toBe("img");
    expect(direct.style["transform"]).toBe("scaleX(-1) scaleY(-1)");
    expect(direct.style["position"]).not.toBe("absolute");
  });

  // CSS function and unit names are case-insensitive per spec — a serializer
  // or upstream layer might emit `ROTATE(90DEG)`. The painter must still
  // produce a bbox wrapper (gemini review on PR 518).
  test("parses ROTATE/DEG case-insensitively", () => {
    expect(parseRotationDegrees("ROTATE(90DEG)")).toBe(90);
    expect(parseRotationDegrees("Rotate(45Deg) scaleX(-1)")).toBe(45);
    expect(parseRotationDegrees("rotate(-90DEG)")).toBe(270);
  });

  test("inlineImageBoundingBox falls back to raw dims for un-rotated images", () => {
    const run: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
    };
    expect(inlineImageBoundingBox(run)).toEqual({ width: 100, height: 200 });
  });

  test("inlineImageBoundingBox swaps dims for 90deg rotation", () => {
    const run: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "rotate(90deg)",
    };
    expect(inlineImageBoundingBox(run)).toEqual({ width: 200, height: 100 });
  });

  test("threads pmStart/pmEnd onto the wrapper so PM positions stay attached", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 200,
      transform: "rotate(90deg)",
      pmStart: 7,
      pmEnd: 8,
    };
    const { block, line } = makeImageOnlyLine(imageRun);

    const lineEl = renderLine(block, line, undefined, fakeDocument);
    const wrapper = lineEl.children[0] as unknown as FakeElement;

    expect(wrapper.dataset["pmStart"]).toBe("7");
    expect(wrapper.dataset["pmEnd"]).toBe("8");
  });
});
