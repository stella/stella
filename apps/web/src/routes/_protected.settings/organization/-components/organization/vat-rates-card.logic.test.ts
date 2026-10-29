import { describe, expect, test } from "bun:test";

import { presetResultWhenCommandStarts } from "./vat-rates-card.logic";

describe("VAT rate preset result", () => {
  test("clears a previous result before another preset command", () => {
    expect(
      presetResultWhenCommandStarts(
        { type: "applyPreset", country: "CZ" },
        { added: 5, skipped: 0 },
      ),
    ).toBeNull();
  });
});
