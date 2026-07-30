import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "@stll/api/types";

import { mergeMobileChatThreadPages } from "./chat-thread-pages";

const message = (id: string): ChatMessage => ({
  id,
  parts: [{ type: "text", content: id }],
  role: "assistant",
});

describe("mergeMobileChatThreadPages", () => {
  test("prepends older cursor pages while preserving each page's order", () => {
    expect(
      mergeMobileChatThreadPages([
        { messages: [message("new-1"), message("new-2")], olderCursor: "c1" },
        { messages: [message("old-1"), message("old-2")], olderCursor: null },
      ]).map(({ id }) => id),
    ).toEqual(["old-1", "old-2", "new-1", "new-2"]);
  });
});
