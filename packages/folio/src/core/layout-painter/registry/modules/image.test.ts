/**
 * Image-module contract test. Verifies the module identifies as "image"
 * and delegates rendering to `renderImageFragment` (anchored class +
 * z-index propagate through).
 */

import { describe, expect, test } from "bun:test";

import type {
  ImageBlock,
  ImageFragment,
  ImageMeasure,
} from "../../../layout-engine/types";
import { IMAGE_CLASS_NAMES } from "../../renderImage";
import type { RenderContext } from "../../renderUtils";
import { imageModule } from "./image";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    add: (...tokens: string[]) => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };
  src = "";
  alt = "";
  draggable = false;
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

const fakeDocument = {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  },
} as unknown as Document;

const ctx: RenderContext = {
  pageNumber: 1,
  totalPages: 1,
  section: "body",
};

const measure: ImageMeasure = { kind: "image", width: 100, height: 80 };

describe("imageModule", () => {
  test("identifies itself as the image kind", () => {
    expect(imageModule.kind).toBe("image");
  });

  test("renders an inline image fragment with the layout-image class", () => {
    const fragment: ImageFragment = {
      kind: "image",
      blockId: "b1",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    };
    const block: ImageBlock = {
      kind: "image",
      id: "b1",
      src: "img.png",
      width: 100,
      height: 80,
    };

    const el = imageModule.render({
      fragment,
      block,
      measure,
      context: ctx,
      doc: fakeDocument,
    }) as unknown as FakeElement;

    expect(el.className).toContain(IMAGE_CLASS_NAMES.image);
    expect(el.className).not.toContain(IMAGE_CLASS_NAMES.imageAnchored);
    expect(el.dataset["blockId"]).toBe("b1");
  });

  test("propagates anchored flag + z-index from fragment", () => {
    const fragment: ImageFragment = {
      kind: "image",
      blockId: "b1",
      x: 10,
      y: 20,
      width: 50,
      height: 50,
      isAnchored: true,
      zIndex: 5,
    };
    const block: ImageBlock = {
      kind: "image",
      id: "b1",
      src: "img.png",
      width: 50,
      height: 50,
    };

    const el = imageModule.render({
      fragment,
      block,
      measure,
      context: ctx,
      doc: fakeDocument,
    }) as unknown as FakeElement;

    expect(el.className).toContain(IMAGE_CLASS_NAMES.imageAnchored);
    expect(el.style["zIndex"]).toBe("5");
  });
});
