import { describe, expect, test } from "bun:test";

import {
  PASTED_TEXT_CHIP_MAX_CHARS,
  PASTED_TEXT_CHIP_MAX_LINES,
  shouldChipPaste,
} from "@/components/chat-pasted-text";
import { buildPastedTextRenderChildren } from "@/components/chat-pasted-text-extension";

describe("long paste threshold", () => {
  test("keeps the character limit inline and attaches only above it", () => {
    expect(shouldChipPaste("a".repeat(PASTED_TEXT_CHIP_MAX_CHARS))).toBe(false);
    expect(shouldChipPaste("a".repeat(PASTED_TEXT_CHIP_MAX_CHARS + 1))).toBe(
      true,
    );
  });
  for (const separator of ["\n", "\r\n", "\r"]) {
    test(`counts lines separated by ${JSON.stringify(separator)} at both edges`, () => {
      expect(
        shouldChipPaste(
          Array.from({ length: PASTED_TEXT_CHIP_MAX_LINES })
            .fill("a")
            .join(separator),
        ),
      ).toBe(false);
      expect(
        shouldChipPaste(
          Array.from({ length: PASTED_TEXT_CHIP_MAX_LINES + 1 })
            .fill("a")
            .join(separator),
        ),
      ).toBe(true);
    });
  }
  test("counts empty lines without a minimum length", () => {
    expect(shouldChipPaste("\n".repeat(PASTED_TEXT_CHIP_MAX_LINES))).toBe(true);
  });
});

describe("buildPastedTextRenderChildren", () => {
  test("returns the text as a single child for single-line content", () => {
    expect(buildPastedTextRenderChildren("hello")).toEqual(["hello"]);
  });

  test("inserts <br>s between lines so newlines survive html-to-markdown", () => {
    expect(buildPastedTextRenderChildren("line1\nline2\nline3")).toEqual([
      "line1",
      ["br"],
      "line2",
      ["br"],
      "line3",
    ]);
  });

  test("represents blank lines as bare <br>s without an empty text node", () => {
    expect(buildPastedTextRenderChildren("a\n\nb")).toEqual([
      "a",
      ["br"],
      ["br"],
      "b",
    ]);
  });

  test("emits an empty children array for empty text", () => {
    expect(buildPastedTextRenderChildren("")).toEqual([]);
  });
});
