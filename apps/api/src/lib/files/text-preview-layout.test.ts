import { describe, expect, test } from "bun:test";

import { paragraphPieces } from "@/api/lib/files/text-preview-layout";

const MARK = /^\p{M}/u;

describe("cutting an enormous line into pieces", () => {
  test("a piece ends after a space near the limit", () => {
    const words = Array.from({ length: 2000 }, () => "slovo").join(" ");
    const pieces = paragraphPieces(words);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(words);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith(" ")).toBe(true);
    }
  });

  test("without a space, a combining mark stays with its letter", () => {
    const line = `${"x".repeat(4095)}e\u0301${"y".repeat(10)}`;
    // The limit falls between the letter and its mark.
    expect(Array.from(line)[4096]).toBe("\u0301");
    const pieces = paragraphPieces(line);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(line);
    for (const piece of pieces) {
      expect(MARK.test(piece)).toBe(false);
    }
  });

  test("a short line is one piece", () => {
    expect(paragraphPieces("kr\u00E1tk\u00FD \u0159\u00E1dek")).toEqual([
      "kr\u00E1tk\u00FD \u0159\u00E1dek",
    ]);
  });
});
