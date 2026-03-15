import { describe, expect, it } from "bun:test";

import { tokenizeText } from "@stella/anonymize";

// ── tokenizeText ─────────────────────────────────────

describe("tokenizeText()", () => {
  it("splits English words with correct offsets", () => {
    const [words, starts, ends] = tokenizeText("Hello world");
    expect(words).toStrictEqual(["Hello", "world"]);
    expect(starts).toStrictEqual([0, 6]);
    expect(ends).toStrictEqual([5, 11]);
  });

  it("handles multiple spaces between words", () => {
    const [words, starts, ends] = tokenizeText("a   b");
    expect(words).toStrictEqual(["a", "b"]);
    expect(starts[1]).toBe(4);
    expect(ends[1]).toBe(5);
  });

  it("handles Czech text with diacritics", () => {
    const [words] = tokenizeText("Jan Novák bydlí v Praze");
    expect(words).toStrictEqual(["Jan", "Novák", "bydlí", "v", "Praze"]);
  });

  it("handles German compound words", () => {
    const [words] = tokenizeText("Mietvertrag zwischen Hans Müller");
    expect(words).toContain("Mietvertrag");
    expect(words).toContain("Müller");
  });

  it("handles CJK characters", () => {
    const [words, starts, ends] = tokenizeText("東京都渋谷区");
    // Intl.Segmenter segments CJK; each character is word-like
    expect(words.length).toBeGreaterThan(0);
    // Offsets should be valid
    for (let i = 0; i < words.length; i++) {
      expect((ends[i] ?? 0) - (starts[i] ?? 0)).toBe(words[i]?.length ?? 0);
    }
  });

  it("returns empty arrays for punctuation-only text", () => {
    const [words, starts, ends] = tokenizeText("... --- !!!");
    expect(words).toStrictEqual([]);
    expect(starts).toStrictEqual([]);
    expect(ends).toStrictEqual([]);
  });

  it("returns empty arrays for empty string", () => {
    const [words] = tokenizeText("");
    expect(words).toStrictEqual([]);
  });

  it("handles mixed script text", () => {
    const [words] = tokenizeText("Hello 世界 Привет");
    expect(words.length).toBeGreaterThanOrEqual(3);
    expect(words).toContain("Hello");
    expect(words).toContain("Привет");
  });

  it("preserves correct character offsets for Unicode", () => {
    const text = "café résumé";
    const [words, starts, ends] = tokenizeText(text);
    for (let i = 0; i < words.length; i++) {
      expect(text.slice(starts[i] ?? 0, ends[i] ?? 0)).toBe(words[i] ?? "");
    }
  });

  it("handles text with numbers", () => {
    const [words] = tokenizeText("IČO 12345678");
    expect(words).toContain("IČO");
    // Bun's Intl.Segmenter may not mark pure digits
    // as word-like; just verify we get at least one word
    expect(words.length).toBeGreaterThan(0);
  });

  // Regression: PDF text fragments that caused
  // "invalid input 'span_idx'" ONNX errors because
  // they produce zero word tokens despite being
  // non-empty after trim().
  it.each([
    ["...", "ellipsis"],
    ["---", "dashes"],
    ["§", "section sign"],
    [")", "closing paren"],
    ['"', "double quote"],
    ["\u201E", "Czech open quote"],
    ["\u201C", "left double quote"],
    ["  . ", "space-dot-space"],
    ["\u00BB", "right guillemet"],
    [",", "comma"],
    [";", "semicolon"],
    ["/:", "slash-colon"],
    ["...\n---\n...", "multi-line punctuation"],
    ["\n\n\n", "newlines only"],
  ])("returns empty for punctuation-only: %s (%s)", (text) => {
    const [words] = tokenizeText(text);
    expect(words).toStrictEqual([]);
  });

  // These look like punctuation but DO contain words
  it.each([
    ["I.", "single letter with period"],
    ["(dále", "paren with word"],
  ])("does produce words for: %s (%s)", (text) => {
    const [words] = tokenizeText(text);
    expect(words.length).toBeGreaterThan(0);
  });
});
