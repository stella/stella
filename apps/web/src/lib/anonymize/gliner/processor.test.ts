import { describe, expect, it } from "bun:test";

import { padArray, tokenizeText } from "./processor";

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
      expect(ends[i] - starts[i]).toBe(words[i].length);
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
      expect(text.slice(starts[i], ends[i])).toBe(words[i]);
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

// ── padArray ─────────────────────────────────────────

describe("padArray()", () => {
  it("pads 2D arrays to uniform length", () => {
    const input = [
      [1, 2, 3],
      [4, 5],
    ];
    const result = padArray(input);
    expect(result[0]).toStrictEqual([1, 2, 3]);
    expect(result[1]).toStrictEqual([4, 5, 0]);
  });

  it("handles already-uniform arrays", () => {
    const input = [
      [1, 2],
      [3, 4],
    ];
    const result = padArray(input);
    expect(result).toStrictEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("pads 3D arrays to uniform length", () => {
    const input = [
      [
        [1, 2],
        [3, 4],
      ],
      [[5, 6]],
    ];
    const result = padArray(input, 3);
    expect(result[0]).toStrictEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(result[1]).toStrictEqual([
      [5, 6],
      [0, 0],
    ]);
  });

  it("handles empty first element in 3D mode", () => {
    // When first batch element is empty but later ones
    // have data, finalDim should be inferred from a
    // non-empty element (not default to 0).
    const input: number[][][] = [[], [[1, 2]]];
    const result = padArray(input, 3);
    expect(result[0]).toHaveLength(1);
    // Padding should produce [0, 0] (matching dim=2)
    expect(result[0][0]).toStrictEqual([0, 0]);
    expect(result[1]).toStrictEqual([[1, 2]]);
  });

  it("handles empty later element in 3D mode", () => {
    // Non-empty first, empty second — should pad second
    const input: number[][][] = [
      [
        [1, 2],
        [3, 4],
      ],
      [],
    ];
    const result = padArray(input, 3);
    expect(result[0]).toStrictEqual([
      [1, 2],
      [3, 4],
    ]);
    // Empty element padded to length 2 with [0, 0] pairs
    expect(result[1]).toStrictEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("handles all-empty elements in 3D mode", () => {
    const input: number[][][] = [[], []];
    const result = padArray(input, 3);
    // maxLength = 0, nothing to pad
    expect(result[0]).toStrictEqual([]);
    expect(result[1]).toStrictEqual([]);
  });

  it("handles single-element arrays", () => {
    const input = [[42]];
    const result = padArray(input);
    expect(result).toStrictEqual([[42]]);
  });
});
