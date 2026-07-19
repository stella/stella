import { describe, expect, test } from "bun:test";

import { CHAT_TITLE_SOURCES } from "@/api/db/schema";
import type { ChatTitleSource } from "@/api/db/schema";

import {
  aiTitlingMayReplace,
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

describe("aiTitlingMayReplace", () => {
  // The whole point of the three-state title source: AI titling replaces only
  // an untouched placeholder. A user rename and a prior AI title are off limits.
  const expected: Record<ChatTitleSource, boolean> = {
    default: true,
    user: false,
    ai: false,
  };

  // Exhaustive over the union so adding a fourth source forces a decision here
  // (the table above stops type-checking) rather than defaulting to replaceable.
  for (const source of CHAT_TITLE_SOURCES) {
    test(`${source} -> ${expected[source] ? "replaceable" : "protected"}`, () => {
      expect(aiTitlingMayReplace(source)).toBe(expected[source]);
    });
  }
});
