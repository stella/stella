import { describe, expect, test } from "bun:test";

import { getClipFieldValueLabel } from "./field-value.logic";

describe("clip field value label", () => {
  test("prefers a non-empty citation", () => {
    expect(
      getClipFieldValueLabel({
        citation: "  Exhibit A at 4  ",
        url: "https://example.com/source.pdf",
      }),
    ).toBe("Exhibit A at 4");
  });

  test("falls back to the url when the citation is blank", () => {
    expect(
      getClipFieldValueLabel({
        citation: "   ",
        url: "https://example.com/source.pdf",
      }),
    ).toBe("https://example.com/source.pdf");
  });
});
