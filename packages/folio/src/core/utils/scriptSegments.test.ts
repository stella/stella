/**
 * Script segmentation drives per-character East-Asian font selection, so it
 * must classify boundary code points correctly and split mixed text into
 * font-homogeneous spans without breaking surrogate pairs.
 */

import { describe, expect, test } from "bun:test";

import { hasCjk, isCjkCodePoint, segmentByScript } from "./scriptSegments";

describe("isCjkCodePoint", () => {
  test("classifies representative East-Asian code points as CJK", () => {
    expect(isCjkCodePoint("世".codePointAt(0)!)).toBe(true); // CJK ideograph
    expect(isCjkCodePoint("あ".codePointAt(0)!)).toBe(true); // Hiragana
    expect(isCjkCodePoint("カ".codePointAt(0)!)).toBe(true); // Katakana
    expect(isCjkCodePoint("한".codePointAt(0)!)).toBe(true); // Hangul syllable
    expect(isCjkCodePoint("、".codePointAt(0)!)).toBe(true); // CJK punctuation
    expect(isCjkCodePoint("ㄅ".codePointAt(0)!)).toBe(true); // Bopomofo (Traditional Chinese)
    expect(isCjkCodePoint("⼀".codePointAt(0)!)).toBe(true); // Kangxi radical
    expect(isCjkCodePoint("Ａ".codePointAt(0)!)).toBe(true); // fullwidth Latin A
    expect(isCjkCodePoint("𠀀".codePointAt(0)!)).toBe(true); // Ext B (astral)
  });

  test("classifies Latin and common punctuation as non-CJK", () => {
    expect(isCjkCodePoint("A".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint("z".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint("1".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint(" ".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint(".".codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint("é".codePointAt(0)!)).toBe(false);
  });
});

describe("hasCjk", () => {
  test("detects any CJK presence and the all-Latin fast path", () => {
    expect(hasCjk("Hello world")).toBe(false);
    expect(hasCjk("Hello 世界")).toBe(true);
    expect(hasCjk("")).toBe(false);
    expect(hasCjk("𠀀")).toBe(true);
  });
});

describe("segmentByScript", () => {
  test("splits mixed text into maximal same-script segments", () => {
    expect(segmentByScript("Hello世界foo")).toEqual([
      { text: "Hello", isCjk: false },
      { text: "世界", isCjk: true },
      { text: "foo", isCjk: false },
    ]);
  });

  test("returns one segment for single-class input", () => {
    expect(segmentByScript("plain ascii")).toEqual([
      { text: "plain ascii", isCjk: false },
    ]);
    expect(segmentByScript("日本語")).toEqual([
      { text: "日本語", isCjk: true },
    ]);
  });

  test("returns no segments for empty input", () => {
    expect(segmentByScript("")).toEqual([]);
  });

  test("keeps an astral ideograph whole within its CJK segment", () => {
    const segments = segmentByScript("x𠀀y");
    expect(segments).toEqual([
      { text: "x", isCjk: false },
      { text: "𠀀", isCjk: true },
      { text: "y", isCjk: false },
    ]);
    // The astral glyph must not be split across the surrogate pair.
    expect(segments[1]?.text.length).toBe(2);
  });

  test("reassembles exactly to the original text", () => {
    const input = "ABCあいうDEFがぎぐ。XYZ";
    expect(
      segmentByScript(input)
        .map((s) => s.text)
        .join(""),
    ).toBe(input);
  });
});
