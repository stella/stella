/**
 * A painted floating image keeps its explicit OOXML size and opts out of the
 * global `img { max-width: 100% }` reset (Tailwind preflight). Without this an
 * image anchored near the right edge — where the remaining content width is
 * below its own width — is capped and squashed against its fixed height.
 * Regression for eigenpal/docx-editor#694.
 */

import { describe, expect, test } from "bun:test";

import {
  renderFloatingImagesLayer,
  type PageFloatingImage,
} from "./renderPage";

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function findImg(element: FakeElement): FakeElement | undefined {
  if (element.tagName === "img") {
    return element;
  }
  for (const child of element.children) {
    const match = findImg(child);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function floatImg(): PageFloatingImage {
  return {
    src: "data:image/png;base64,AAAA",
    width: 96,
    height: 96,
    side: "right",
    x: 600,
    y: 0,
    distTop: 0,
    distBottom: 0,
    distLeft: 0,
    distRight: 0,
    affectsTextWrap: false,
    behindDoc: false,
  };
}

describe("floating image rendering", () => {
  test("keeps explicit OOXML size and opts out of the max-width reset", () => {
    const layer = renderFloatingImagesLayer(
      [floatImg()],
      fakeDocument,
    ) as unknown as FakeElement;

    const img = findImg(layer);
    expect(img).toBeDefined();
    expect(img!.style["width"]).toBe("96px");
    expect(img!.style["height"]).toBe("96px");
    expect(img!.style["maxWidth"]).toBe("none");
    expect(img!.style["maxHeight"]).toBe("none");
  });
});
