import { describe, expect, test } from "bun:test";

import { nativeCopyMatches } from "./copy-control.logic";

describe("a native copy matches a Copy's payload", () => {
  test("when the text is the same", () => {
    expect(
      nativeCopyMatches({ copied: "2026/014-A", payload: "2026/014-A" }),
    ).toBe(true);
  });

  test("whatever the whitespace and line endings", () => {
    expect(
      nativeCopyMatches({
        copied: "  Line one\r\n\tline   two\n",
        payload: "Line one\nline two",
      }),
    ).toBe(true);
  });

  test("never for part of the payload or a character more", () => {
    for (const copied of [
      "2026/014",
      "2026/014-A.",
      "2026/014-a",
      "026/014-A",
    ]) {
      expect(nativeCopyMatches({ copied, payload: "2026/014-A" })).toBe(false);
    }
  });

  test("never for an empty copy, even of an empty payload", () => {
    expect(nativeCopyMatches({ copied: " \n ", payload: "" })).toBe(false);
  });

  test("whether or not the browser broke the lines of a block", () => {
    // A code block's lines serialize with or without line breaks between
    // them, depending on how the browser lays the block out.
    expect(
      nativeCopyMatches({
        copied: '{  "query": "nájemní smlouva"}',
        payload: '{\n  "query": "nájemní smlouva"\n}',
      }),
    ).toBe(true);
  });

  test("never for different characters at the same length", () => {
    expect(
      nativeCopyMatches({ copied: "2026/015-A", payload: "2026/014-A" }),
    ).toBe(false);
  });
});
