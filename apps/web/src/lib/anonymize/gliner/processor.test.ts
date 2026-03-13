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
    expect(words).toContain("12345678");
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

  it("handles empty inner arrays in 3D mode gracefully", () => {
    // When first batch is empty, finalDim can't be inferred;
    // padding fills with scalar 0s (degenerate but non-crashing)
    const input: number[][][] = [[], [[1, 2]]];
    const result = padArray(input, 3);
    expect(result[0]).toHaveLength(1);
    expect(result[1]).toStrictEqual([[1, 2]]);
  });

  it("handles single-element arrays", () => {
    const input = [[42]];
    const result = padArray(input);
    expect(result).toStrictEqual([[42]]);
  });
});
