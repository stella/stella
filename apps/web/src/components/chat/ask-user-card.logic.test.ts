import { describe, expect, test } from "bun:test";

import {
  ASK_USER_MAX_CHIP_OPTION_LENGTH,
  ASK_USER_MAX_CHIP_OPTIONS,
  ASK_USER_OPTION_LAYOUT,
  askUserOptionLayout,
} from "@/components/chat/ask-user-card.logic";

const optionsOf = (count: number, length = 5): string[] =>
  Array.from({ length: count }, (_, index) =>
    String(index).padEnd(length, "x"),
  );

describe("ask-user option layout", () => {
  test("lists a multiple-choice question only when it has many or long options", () => {
    const layoutOf = (options: string[], selection?: "multiple") =>
      askUserOptionLayout({
        question: "Which?",
        reason: "Scope.",
        options,
        ...(selection === undefined ? {} : { selection }),
      });

    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS), "multiple")).toBe(
      ASK_USER_OPTION_LAYOUT.chips,
    );
    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS + 1), "multiple")).toBe(
      ASK_USER_OPTION_LAYOUT.list,
    );
    expect(
      layoutOf(
        ["Short", "x".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH)],
        "multiple",
      ),
    ).toBe(ASK_USER_OPTION_LAYOUT.chips);
    expect(
      layoutOf(
        ["Short", "x".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH + 1)],
        "multiple",
      ),
    ).toBe(ASK_USER_OPTION_LAYOUT.list);
    // Length is counted in characters as read: each flag is one, not four
    // UTF-16 units.
    expect(
      layoutOf(["🇨🇿".repeat(ASK_USER_MAX_CHIP_OPTION_LENGTH)], "multiple"),
    ).toBe(ASK_USER_OPTION_LAYOUT.chips);
    expect(layoutOf(optionsOf(ASK_USER_MAX_CHIP_OPTIONS + 1))).toBe(
      ASK_USER_OPTION_LAYOUT.chips,
    );
  });
});
