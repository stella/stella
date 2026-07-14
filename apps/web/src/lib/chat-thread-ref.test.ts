import { describe, expect, test } from "bun:test";

import {
  resolveChatContextMatterIds,
  toChatThreadId,
} from "@/lib/chat-thread-ref";

describe("chat matter context", () => {
  test("keeps the route matter exactly once in workspace chats", () => {
    expect(
      resolveChatContextMatterIds(
        {
          scope: "workspace",
          threadId: toChatThreadId("thread-id"),
          workspaceId: "route-matter",
        },
        ["extra-matter", "route-matter", "extra-matter"],
      ),
    ).toEqual(["route-matter", "extra-matter"]);
  });

  test("does not add a matter to global chats", () => {
    expect(
      resolveChatContextMatterIds(
        { scope: "global", threadId: toChatThreadId("thread-id") },
        ["selected-matter", "selected-matter"],
      ),
    ).toEqual(["selected-matter"]);
  });
});
