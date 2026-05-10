import { describe, expect, test } from "bun:test";

import {
  PASTED_TEXT_CHIP_MIN_CHARS,
  PASTED_TEXT_CHIP_MIN_CHARS_WITH_LINE_BREAKS,
  PASTED_TEXT_CHIP_MIN_LINE_BREAKS,
  shouldChipPaste,
} from "@/components/chat-pasted-text";

describe("shouldChipPaste", () => {
  test("leaves a single sentence as raw text", () => {
    expect(shouldChipPaste("Quick note for the team.")).toBe(false);
  });

  test("collapses long single-line pastes", () => {
    expect(shouldChipPaste("a".repeat(PASTED_TEXT_CHIP_MIN_CHARS))).toBe(true);
  });

  test("collapses substantial multi-line pastes below the char threshold", () => {
    const linePadding = "x".repeat(
      Math.ceil(
        PASTED_TEXT_CHIP_MIN_CHARS_WITH_LINE_BREAKS /
          (PASTED_TEXT_CHIP_MIN_LINE_BREAKS + 1),
      ),
    );
    const text = Array.from(
      { length: PASTED_TEXT_CHIP_MIN_LINE_BREAKS + 1 },
      () => linePadding,
    ).join("\n");
    expect(text.length).toBeLessThan(PASTED_TEXT_CHIP_MIN_CHARS);
    expect(shouldChipPaste(text)).toBe(true);
  });

  test("leaves short multi-line pastes alone", () => {
    expect(shouldChipPaste("foo\nbar\nbaz")).toBe(false);
  });

  test("leaves a multi-line paste alone when total length is small even with many newlines", () => {
    expect(shouldChipPaste("a\nb\nc\nd\ne\nf\ng")).toBe(false);
  });
});
