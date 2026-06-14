import { describe, expect, test } from "bun:test";

import { escapeXml } from "./xml.js";

describe("escapeXml", () => {
  test("escapes the five XML entities", () => {
    expect(escapeXml(`<a href="x" id='y'>&z`)).toBe(
      "&lt;a href=&quot;x&quot; id=&apos;y&apos;&gt;&amp;z",
    );
  });

  test("preserves tab, LF and CR", () => {
    const input = `a${String.fromCodePoint(9)}b${String.fromCodePoint(
      10,
    )}c${String.fromCodePoint(13)}d`;
    expect(escapeXml(input)).toBe(input);
  });

  test("strips XML 1.0 illegal control characters", () => {
    const input = `a${String.fromCodePoint(0)}b${String.fromCodePoint(
      8,
    )}c${String.fromCodePoint(0x0b)}d${String.fromCodePoint(
      0x0c,
    )}e${String.fromCodePoint(0x1f)}f`;
    expect(escapeXml(input)).toBe("abcdef");
  });

  test("preserves astral characters", () => {
    const doc = String.fromCodePoint(0x1_f4_c4);
    expect(escapeXml(`page ${doc} 1`)).toBe(`page ${doc} 1`);
  });

  test("strips unpaired surrogate halves", () => {
    const high = String.fromCodePoint(0xd8_00);
    const low = String.fromCodePoint(0xdc_00);
    expect(escapeXml(`a${high}b${low}c`)).toBe("abc");
  });
});
