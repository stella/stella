import { describe, expect, test } from "bun:test";

import {
  dictationImportLines,
  dictationTermKey,
  isStoredDictationTerm,
  MAX_DICTATION_TERM_LENGTH,
  readDictationTerm,
  readDictationTermImport,
} from "./dictation-vocabulary";

describe("a dictation word as the list stores it", () => {
  test("is NFC, single-spaced and trimmed, and keyed without case", () => {
    expect(readDictationTerm("  Hogan \t  Lovells ")).toEqual({
      type: "term",
      term: "Hogan Lovells",
      key: "hogan lovells",
    });
    // "Novák" with a combining acute composes to the same word.
    expect(readDictationTerm("Novák")).toEqual({
      type: "term",
      term: "Novák",
      key: "novák",
    });
    // Diacritics stay: these are two words.
    expect(dictationTermKey("Novák")).not.toBe(dictationTermKey("Novak"));
  });

  test("a blank, a too long word and a control character are told apart", () => {
    expect(readDictationTerm(" \t ")).toEqual({ type: "blank" });
    expect(
      readDictationTerm("x".repeat(MAX_DICTATION_TERM_LENGTH)),
    ).toMatchObject({ type: "term" });
    expect(
      readDictationTerm("x".repeat(MAX_DICTATION_TERM_LENGTH + 1)),
    ).toEqual({ type: "too-long" });
    expect(readDictationTerm("bell\u0007")).toEqual({ type: "invalid" });
    expect(
      readDictationTerm(`left${String.fromCodePoint(0x20_2e)}right`),
    ).toEqual({ type: "invalid" });
  });

  test("a stored word is one that reads back unchanged", () => {
    expect(isStoredDictationTerm("Hogan Lovells")).toBe(true);
    expect(isStoredDictationTerm(" Hogan Lovells")).toBe(false);
    expect(isStoredDictationTerm("Hogan  Lovells")).toBe(false);
    expect(isStoredDictationTerm("Novák")).toBe(false);
    expect(isStoredDictationTerm("")).toBe(false);
  });
});

describe("an import", () => {
  test("names each word once and counts what it leaves out", () => {
    expect(
      readDictationTermImport([
        "Novák",
        "",
        "novák",
        "NOVÁK ",
        "x".repeat(MAX_DICTATION_TERM_LENGTH + 1),
        "a\u0000b",
        "Deloitte",
      ]),
    ).toEqual({
      terms: [
        { term: "Novák", key: "novák" },
        { term: "Deloitte", key: "deloitte" },
      ],
      repeated: 2,
      tooLong: 1,
      invalid: 1,
    });
  });

  test("reads one word per line, or the first cell of each CSV row", () => {
    expect(dictationImportLines("﻿Novák\r\nDeloitte\rKPMG\n", "lines")).toEqual(
      ["Novák", "Deloitte", "KPMG", ""],
    );
    expect(
      dictationImportLines(
        'Novák,client\n"Smith, Jones & Co";firm\n"Say ""hi""",x\nKPMG',
        "csv",
      ),
    ).toEqual(["Novák", "Smith, Jones & Co", 'Say "hi"', "KPMG"]);
  });
});
