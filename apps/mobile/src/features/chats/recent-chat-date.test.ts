import { describe, expect, test } from "bun:test";

import { formatRecentChatDate } from "./recent-chat-date";

const NOW = new Date("2026-07-22T12:00:00.000Z");

describe("formatRecentChatDate", () => {
  test("uses locale-aware time for conversations updated today", () => {
    expect(
      formatRecentChatDate("2026-07-22T10:30:00.000Z", {
        locale: "en-GB",
        now: NOW,
      }),
    ).toBe("10:30");
  });

  test("adds the year only when it carries information", () => {
    expect(
      formatRecentChatDate("2026-06-02T10:30:00.000Z", {
        locale: "en-GB",
        now: NOW,
      }),
    ).toBe("2 Jun");
    expect(
      formatRecentChatDate("2025-06-02T10:30:00.000Z", {
        locale: "en-GB",
        now: NOW,
      }),
    ).toBe("2 Jun 2025");
  });
});
