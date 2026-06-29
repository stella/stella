import { describe, expect, test } from "bun:test";

import { detectBaseDirection } from "./baseDirection";

describe("detectBaseDirection", () => {
  test("Arabic-led text is RTL", () => {
    expect(detectBaseDirection("هذا نص عربي")).toBe("rtl");
  });

  test("Hebrew-led text is RTL", () => {
    expect(detectBaseDirection("שלום עולם")).toBe("rtl");
  });

  test("Latin-led text is LTR", () => {
    expect(detectBaseDirection("Hello world")).toBe("ltr");
  });

  test("weak/neutral-only text is undecided (null)", () => {
    expect(detectBaseDirection("123 456 — !!!  ")).toBe(null);
    expect(detectBaseDirection("")).toBe(null);
  });

  test("leading digits and punctuation are skipped; first letter decides", () => {
    expect(detectBaseDirection("123. العربية")).toBe("rtl");
    expect(detectBaseDirection("(2024) Contract")).toBe("ltr");
  });

  test("explicit bidi marks override the first letter", () => {
    const LRM = String.fromCodePoint(8206);
    const RLM = String.fromCodePoint(8207);
    // LRM before Arabic forces LTR; RLM before Latin forces RTL.
    expect(detectBaseDirection(`${LRM}عربي`)).toBe("ltr");
    expect(detectBaseDirection(`${RLM}Hello`)).toBe("rtl");
  });
});
