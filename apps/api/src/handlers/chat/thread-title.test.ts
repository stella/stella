import { describe, expect, test } from "bun:test";

import {
  CHAT_THREAD_PLACEHOLDER_TITLE,
  shouldRefreshEmptyThreadTitle,
} from "./thread-title";

describe("shouldRefreshEmptyThreadTitle", () => {
  test("refreshes empty placeholder chats", () => {
    expect(
      shouldRefreshEmptyThreadTitle({
        messageCount: 0,
        title: CHAT_THREAD_PLACEHOLDER_TITLE,
      }),
    ).toBe(true);
  });

  test("preserves empty file thread titles", () => {
    expect(
      shouldRefreshEmptyThreadTitle({
        messageCount: 0,
        title: "Evidence bundle.pdf",
      }),
    ).toBe(false);
  });

  test("preserves populated placeholder chats", () => {
    expect(
      shouldRefreshEmptyThreadTitle({
        messageCount: 1,
        title: CHAT_THREAD_PLACEHOLDER_TITLE,
      }),
    ).toBe(false);
  });
});
