import { describe, expect, test } from "bun:test";

import type {
  ImageBlock,
  ImageFragment,
  ImageMeasure,
  ImageRun,
  MeasuredLine,
  ParagraphBlock,
} from "../layout-engine/types";
import {
  applyImageVisualAttrs,
  hasImageVisualAttrs,
  renderImageFragment,
} from "./renderImage";
import { renderLine } from "./renderParagraph";

// Render-pipeline follow-up to PR #513 (eigenpal #424): the model layer now
// parses <a:alphaModFix amt> into `Image.opacity`, but the layout/painter
// chain previously dropped it on the floor so partially-transparent images
// still painted fully opaque. Mirrors eigenpal's `ImageVisualAttrs` helper
// gated by `!= null` so the ProseMirror `null` defaults don't read as 0.

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
  alt = "";
  draggable = true;
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

const baseImageBlock = (overrides: Partial<ImageBlock> = {}): ImageBlock => ({
  kind: "image",
  id: "img-1",
  src: "data:image/png;base64,",
  width: 100,
  height: 80,
  ...overrides,
});

const baseImageFragment = (
  overrides: Partial<ImageFragment> = {},
): ImageFragment => ({
  kind: "image",
  blockId: "img-1",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ...overrides,
});

const baseImageMeasure: ImageMeasure = {
  kind: "image",
  width: 100,
  height: 80,
};

// Minimal RenderContext stub; `renderImageFragment` ignores the value.
const fakeContext = {} as Parameters<typeof renderImageFragment>[3];

const findImageDescendant = (el: FakeElement): FakeElement | undefined => {
  if (el.tagName === "img") {
    return el;
  }
  for (const child of el.children) {
    const found = findImageDescendant(child);
    if (found) {
      return found;
    }
  }
  return undefined;
};

describe("renderImageFragment opacity (floating block path)", () => {
  test("emits CSS opacity for a floating image with opacity 0.5", () => {
    const block = baseImageBlock({ opacity: 0.5 });
    const fragment = baseImageFragment({ isAnchored: true });

    const containerEl = renderImageFragment(
      fragment,
      block,
      baseImageMeasure,
      fakeContext,
      { document: fakeDocument },
    ) as unknown as FakeElement;

    const imgEl = findImageDescendant(containerEl);
    expect(imgEl?.style["opacity"]).toBe("0.5");
  });

  test("does not set CSS opacity when the image has no opacity attribute", () => {
    const block = baseImageBlock();
    const fragment = baseImageFragment({ isAnchored: true });

    const containerEl = renderImageFragment(
      fragment,
      block,
      baseImageMeasure,
      fakeContext,
      { document: fakeDocument },
    ) as unknown as FakeElement;

    const imgEl = findImageDescendant(containerEl);
    expect(imgEl?.style["opacity"]).toBeUndefined();
  });
});

describe("renderLine inline image opacity", () => {
  test("emits CSS opacity on the inline <img> when run carries opacity 0.5", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 80,
      opacity: 0.5,
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
      width: 100,
      ascent: 20,
      descent: 3,
      lineHeight: 23,
    };

    const lineEl = renderLine(
      block,
      line,
      undefined,
      fakeDocument,
    ) as unknown as FakeElement;
    const imgEl = findImageDescendant(lineEl);

    expect(imgEl?.style["opacity"]).toBe("0.5");
  });

  // Regression guard for the upstream null-default leak. ProseMirror schema
  // attrs default to `null`, so `!== undefined` would erroneously gate the
  // write on plain images and paint them at opacity 0. The helper must use
  // `!= null` so absent/null opacity skips the write entirely.
  test("does not set CSS opacity on a plain inline image with no opacity attribute", () => {
    const imageRun: ImageRun = {
      kind: "image",
      src: "data:image/png;base64,",
      width: 100,
      height: 80,
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
      width: 100,
      ascent: 20,
      descent: 3,
      lineHeight: 23,
    };

    const lineEl = renderLine(
      block,
      line,
      undefined,
      fakeDocument,
    ) as unknown as FakeElement;
    const imgEl = findImageDescendant(lineEl);

    expect(imgEl?.style["opacity"]).toBeUndefined();
  });
});

describe("ImageVisualAttrs helpers", () => {
  test("hasImageVisualAttrs returns true for opacity < 1", () => {
    expect(hasImageVisualAttrs({ opacity: 0.5 })).toBe(true);
  });

  test("hasImageVisualAttrs returns false for opacity 1 (fully opaque)", () => {
    expect(hasImageVisualAttrs({ opacity: 1 })).toBe(false);
  });

  // Regression: ProseMirror schema attrs default to `null`, which slips
  // through `as number | undefined` casts in the bridge. Treat null exactly
  // like undefined so plain images don't accidentally paint at opacity 0.
  test("hasImageVisualAttrs returns false for opacity null (PM schema default)", () => {
    // The bridge boxes the PM null default as `number | undefined`; the
    // helper sees a literal null at runtime. Force the same shape here.
    const attrs = { opacity: null } as unknown as { opacity?: number };
    expect(hasImageVisualAttrs(attrs)).toBe(false);
  });

  test("applyImageVisualAttrs skips the opacity write for a null PM default", () => {
    const img = fakeDocument.createElement(
      "img",
    ) as unknown as HTMLImageElement;
    const attrs = { opacity: null } as unknown as { opacity?: number };
    applyImageVisualAttrs(img, attrs);
    expect((img as unknown as FakeElement).style["opacity"]).toBeUndefined();
  });
});
