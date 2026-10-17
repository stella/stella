import { describe, expect, test } from "bun:test";

import {
  claimQueuedChatSend,
  findQueuedChatSend,
  hasQueuedChatSend,
  queueChatSend,
  settleQueuedChatSend,
} from "@/features/chat/queued-chat-sends";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

const thread = (threadId: string): ChatThreadRef => ({
  scope: "global",
  threadId,
});

describe("queued chat sends", () => {
  test("a message being sent stays discoverable, so a second press joins its thread", () => {
    const ref = thread("queued-sending");
    queueChatSend(ref, "<p>Question</p>");
    expect(claimQueuedChatSend(ref)).toBe("<p>Question</p>");
    // Pressed again while the first send is still in flight.
    expect(findQueuedChatSend("<p>Question</p>")).toEqual(ref);
    queueChatSend(ref, "<p>Question</p>");
    expect(hasQueuedChatSend(ref)).toBe(false);
    expect(claimQueuedChatSend(ref)).toBeNull();
    settleQueuedChatSend(ref, "sent");
    expect(findQueuedChatSend("<p>Question</p>")).toBeUndefined();
  });

  test("a send that did not go through waits again for the next attempt", () => {
    const ref = thread("queued-retry");
    queueChatSend(ref, "<p>Retry</p>");
    expect(claimQueuedChatSend(ref)).toBe("<p>Retry</p>");
    settleQueuedChatSend(ref, "not-sent");
    expect(hasQueuedChatSend(ref)).toBe(true);
    expect(claimQueuedChatSend(ref)).toBe("<p>Retry</p>");
    settleQueuedChatSend(ref, "sent");
    expect(hasQueuedChatSend(ref)).toBe(false);
  });
});
