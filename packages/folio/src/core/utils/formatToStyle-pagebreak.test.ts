// paragraphToStyle must emit the modern CSS Fragmentation `break-*` properties,
// not the deprecated `page-break-*` aliases. `page-break-before: always` maps to
// `break-before: page`; the `avoid` values carry over unchanged.

import { describe, expect, test } from "bun:test";

import type { ParagraphFormatting } from "../types/document";
import { paragraphToStyle } from "./formatToStyle";

describe("paragraphToStyle — page-break properties", () => {
  test("pageBreakBefore forces a page break via break-before", () => {
    expect(paragraphToStyle({ pageBreakBefore: true }).breakBefore).toBe(
      "page",
    );
  });

  test("keepNext avoids a break after the paragraph", () => {
    expect(paragraphToStyle({ keepNext: true }).breakAfter).toBe("avoid");
  });

  test("keepLines avoids breaking inside the paragraph", () => {
    expect(paragraphToStyle({ keepLines: true }).breakInside).toBe("avoid");
  });

  test("no break flags emit no break properties", () => {
    const style = paragraphToStyle({} as ParagraphFormatting);
    expect(style.breakBefore).toBeUndefined();
    expect(style.breakAfter).toBeUndefined();
    expect(style.breakInside).toBeUndefined();
  });
});
