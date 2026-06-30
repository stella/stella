import { describe, expect, test } from "bun:test";

import { applyArabicFolds, applyArabicFoldsWithOffsets } from "./arabic.js";

describe("applyArabicFoldsWithOffsets", () => {
  test("folds 1:1 and maps each unit to its source", () => {
    const { sourceEndIndex, text, sourceIndex } =
      applyArabicFoldsWithOffsets("أحمد");
    expect(text).toBe("احمد");
    expect(sourceIndex).toEqual([0, 1, 2, 3, 4]);
    expect(sourceEndIndex).toEqual([1, 2, 3, 4, 4]);
  });

  test("drops removed chars; offsets point at the surviving sources", () => {
    // م(0) ـ(1) ح(2) ـ(3) م(4) ـ(5) د(6) -> محمد
    const { sourceEndIndex, text, sourceIndex } =
      applyArabicFoldsWithOffsets("مـحـمـد");
    expect(text).toBe("محمد");
    expect(sourceIndex).toEqual([0, 2, 4, 6, 7]);
    expect(sourceEndIndex).toEqual([1, 3, 5, 7, 7]);
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

  test("NFKC-folds Arabic presentation forms", () => {
    expect(applyArabicFoldsWithOffsets("ﺍﺣﻤﺪ").text).toBe("احمد");
  });

  test("expands a ligature and maps every unit to its source char", () => {
    // ﷲ (U+FDF2) is one code unit; NFKC expands it to الله (4 units).
    const { sourceEndIndex, text, sourceIndex } =
      applyArabicFoldsWithOffsets("ﷲ");
    expect(text).toBe("الله");
    expect(sourceIndex).toEqual([0, 0, 0, 0, 1]);
    expect(sourceEndIndex).toEqual([1, 1, 1, 1, 1]);
  });

  test("a folded match maps back to the original substring", () => {
    const original = "رقم ٢٠٢٤ نهائي";
    const { sourceEndIndex, text, sourceIndex } =
      applyArabicFoldsWithOffsets(original);
    const foldedStart = text.indexOf("2024");
    const foldedEnd = foldedStart + "2024".length;
    const origSlice = original.slice(
      sourceIndex[foldedStart],
      sourceEndIndex[foldedEnd - 1],
    );
    expect(origSlice).toBe("٢٠٢٤");
  });
});
