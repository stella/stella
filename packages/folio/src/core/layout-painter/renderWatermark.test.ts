/**
 * Painter coverage for the document watermark layer. Uses a lightweight
 * FakeElement document to stay Bun-native, mirroring the convention in
 * `renderPage-pageBorders.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import type { Page } from "../layout-engine/types";
import { renderWatermarkLayer } from "./renderWatermark";

class FakeElement {
  className = "";
  textContent = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  readonly tagName: string;
  src?: string;
  alt?: string;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
}

const fakeDocument = {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  },
} as unknown as Document;

function pageFixture(): Page {
  return {
    number: 1,
    fragments: [],
    margins: { top: 96, right: 96, bottom: 96, left: 96 },
    size: { w: 816, h: 1056 },
  };
}

describe("renderWatermarkLayer", () => {
  test("renders a centered, diagonally-rotated text watermark", () => {
    const layer = renderWatermarkLayer(
      { kind: "text", text: "CONFIDENTIAL" },
      pageFixture(),
      fakeDocument,
    ) as unknown as FakeElement | null;
    expect(layer).not.toBeNull();
    if (!layer) {
      throw new TypeError("layer was null");
    }
    expect(layer.className).toBe("layout-page-watermark");
    expect(layer.style["width"]).toBe("816px");
    expect(layer.style["height"]).toBe("1056px");
    expect(layer.style["pointerEvents"]).toBe("none");
    expect(layer.style["zIndex"]).toBe("0");
    const child = layer.firstElementChild;
    expect(child?.textContent).toBe("CONFIDENTIAL");
    expect(child?.style["transform"]).toBe("rotate(-45deg)");
    expect(child?.style["color"]).toBe("#C0C0C0");
    expect(child?.style["opacity"]).toBe("0.5");
  });

  test("honors diagonal:false (Word's Horizontal preset)", () => {
    const layer = renderWatermarkLayer(
      { kind: "text", text: "DRAFT", diagonal: false },
      pageFixture(),
      fakeDocument,
    ) as unknown as FakeElement;
    expect(layer.firstElementChild?.style["transform"]).toBe("rotate(0deg)");
  });

  test("honors a parsed color override", () => {
    const layer = renderWatermarkLayer(
      { kind: "text", text: "URGENT", color: "FF0000" },
      pageFixture(),
      fakeDocument,
    ) as unknown as FakeElement;
    expect(layer.firstElementChild?.style["color"]).toBe("#FF0000");
  });

  test("honors a parsed opacity override", () => {
    const layer = renderWatermarkLayer(
      { kind: "text", text: "T", opacity: 0.25 },
      pageFixture(),
      fakeDocument,
    ) as unknown as FakeElement;
    expect(layer.firstElementChild?.style["opacity"]).toBe("0.25");
  });

  test("renders a picture watermark when imageSrc is resolved", () => {
    const layer = renderWatermarkLayer(
      { kind: "picture", imageRId: "rId42" },
      pageFixture(),
      fakeDocument,
      { imageSrc: "data:image/png;base64,iVBORw0KGgo=" },
    ) as unknown as FakeElement;
    const img = layer.firstElementChild;
    expect(img?.tagName).toBe("IMG");
    expect(img?.src).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(img?.alt).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.style["opacity"]).toBe("0.4");
  });

  test("returns null for a picture watermark without a resolved src", () => {
    const layer = renderWatermarkLayer(
      { kind: "picture", imageRId: "rId42" },
      pageFixture(),
      fakeDocument,
    );
    expect(layer).toBeNull();
  });

  test("honors washout:false (full opacity)", () => {
    const layer = renderWatermarkLayer(
      { kind: "picture", imageRId: "rId1", washout: false },
      pageFixture(),
      fakeDocument,
      { imageSrc: "data:image/png;base64,_" },
    ) as unknown as FakeElement;
    expect(layer.firstElementChild?.style["opacity"]).toBe("1");
  });

  test("honors a custom scale percentage", () => {
    const layer = renderWatermarkLayer(
      { kind: "picture", imageRId: "rId1", scale: 60 },
      pageFixture(),
      fakeDocument,
      { imageSrc: "data:image/png;base64,_" },
    ) as unknown as FakeElement;
    expect(layer.firstElementChild?.style["maxWidth"]).toBe("60%");
    expect(layer.firstElementChild?.style["maxHeight"]).toBe("60%");
  });

  test("text watermark uses textContent, not raw HTML injection", () => {
    // Defensive: catch any future refactor that swaps textContent for
    // innerHTML — the input may be authored anywhere upstream and we
    // never want the painter to execute markup from the model.
    const layer = renderWatermarkLayer(
      { kind: "text", text: "<script>alert(1)</script>" },
      pageFixture(),
      fakeDocument,
    ) as unknown as FakeElement;
    const child = layer.firstElementChild;
    expect(child?.textContent).toBe("<script>alert(1)</script>");
    // No nested children — textContent does not parse HTML.
    expect(child?.children.length).toBe(0);
  });
});
