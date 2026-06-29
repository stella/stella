import { describe, expect, test } from "bun:test";

import { applyArabicFolds, applyArabicFoldsWithOffsets } from "./arabic.js";

describe("applyArabicFoldsWithOffsets", () => {
  test("folds 1:1 and maps each unit to its source", () => {
    const { text, sourceIndex } = applyArabicFoldsWithOffsets("أحمد");
    expect(text).toBe("احمد");
    expect(sourceIndex).toEqual([0, 1, 2, 3, 4]);
  });

  test("drops removed chars; offsets point at the surviving sources", () => {
    // م(0) ـ(1) ح(2) ـ(3) م(4) ـ(5) د(6) -> محمد
    const { text, sourceIndex } = applyArabicFoldsWithOffsets("مـحـمـد");
    expect(text).toBe("محمد");
    expect(sourceIndex).toEqual([0, 2, 4, 6, 7]);
  });

  test("maps Arabic-Indic digits", () => {
    const { text, sourceIndex } = applyArabicFoldsWithOffsets("٢٠٢٤");
    expect(text).toBe("2024");
    expect(sourceIndex).toEqual([0, 1, 2, 3, 4]);
  });

  test("preserves astral characters spanning two code units", () => {
    // 𐍈 (U+10348) is a surrogate pair (2 units); ا is one unit.
    const { text, sourceIndex } = applyArabicFoldsWithOffsets("𐍈ا");
    expect(text).toBe("𐍈ا");
    expect(sourceIndex).toEqual([0, 0, 2, 3]);
  });

  test("folded text equals applyArabicFolds", () => {
    for (const input of ["أحمد", "مـحـمـد", "٢٠٢٤", "خدمة", "Hello"]) {
      expect(applyArabicFoldsWithOffsets(input).text).toBe(
        applyArabicFolds(input),
      );
    }
  });

  test("a folded match maps back to the original substring", () => {
    const original = "رقم ٢٠٢٤ نهائي";
    const { text, sourceIndex } = applyArabicFoldsWithOffsets(original);
    const foldedStart = text.indexOf("2024");
    const foldedEnd = foldedStart + "2024".length;
    const origSlice = original.slice(
      sourceIndex[foldedStart],
      sourceIndex[foldedEnd],
    );
    expect(origSlice).toBe("٢٠٢٤");
  });
});
