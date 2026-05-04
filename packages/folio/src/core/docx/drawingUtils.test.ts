import { describe, expect, test } from "bun:test";

import { parseColorElement } from "./drawingUtils";
import type { XmlElement } from "./xmlParser";

function el(name: string, attributes: Record<string, string> = {}): XmlElement {
  return { name, type: "element", attributes };
}

function wrap(child: XmlElement): XmlElement {
  return { name: "wrapper", type: "element", elements: [child] };
}

describe("drawingUtils.parseColorElement", () => {
  test("accepts a well-formed srgbClr value and uppercases it", () => {
    const result = parseColorElement(wrap(el("a:srgbClr", { val: "ff8800" })));
    expect(result).toEqual({ rgb: "FF8800" });
  });

  test("rejects srgbClr values that are not exactly six hex digits", () => {
    for (const val of [
      "FF",
      "FFFFFFF",
      "GGGGGG",
      "FFFFF#",
      "FF8800;color:red",
      `FF8800"/><script>alert(1)</script>`,
      "url(javascript:alert(1))",
      "",
    ]) {
      const result = parseColorElement(wrap(el("a:srgbClr", { val })));
      expect(result).toBeUndefined();
    }
  });

  test("falls back to black for sysClr without a hex lastClr", () => {
    const result = parseColorElement(
      wrap(el("a:sysClr", { val: "windowText", lastClr: `not-hex"/>` })),
    );
    expect(result).toEqual({ rgb: "000000" });
  });

  test("uses the validated lastClr from sysClr when present", () => {
    const result = parseColorElement(
      wrap(el("a:sysClr", { val: "windowText", lastClr: "1f497d" })),
    );
    expect(result).toEqual({ rgb: "1F497D" });
  });
});
