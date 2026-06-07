import { describe, expect, test } from "bun:test";

import { isSafeMarkdownPreviewImageSrc } from "./markdown-preview.logic";

describe("markdown preview image sources", () => {
  test("allows embedded raster data images", () => {
    expect(isSafeMarkdownPreviewImageSrc("data:image/png;base64,AAAA")).toBe(
      true,
    );
    expect(isSafeMarkdownPreviewImageSrc("data:image/jpeg;base64,AAAA")).toBe(
      true,
    );
  });

  test("blocks remote and SVG data image sources", () => {
    expect(isSafeMarkdownPreviewImageSrc("https://tracker.example/p.gif")).toBe(
      false,
    );
    expect(
      isSafeMarkdownPreviewImageSrc(
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      ),
    ).toBe(false);
  });
});
