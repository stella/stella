import { describe, expect, test } from "bun:test";

import { PDF_COLOR_MODES, resolvePDFInvertColors } from "./pdf-color-mode";

describe("PDF color mode", () => {
  test("keeps image-origin PDFs in their original colors", () => {
    for (const colorMode of PDF_COLOR_MODES) {
      expect(
        resolvePDFInvertColors({ colorMode, isImageOrigin: true }),
      ).toBeFalse();
    }
  });

  test("can force original, inverted, or system-matched PDF colors", () => {
    expect(
      resolvePDFInvertColors({ colorMode: "light", isImageOrigin: false }),
    ).toBeFalse();
    expect(
      resolvePDFInvertColors({ colorMode: "dark", isImageOrigin: false }),
    ).toBeTrue();
    expect(
      resolvePDFInvertColors({ colorMode: "system", isImageOrigin: false }),
    ).toBeUndefined();
  });
});
