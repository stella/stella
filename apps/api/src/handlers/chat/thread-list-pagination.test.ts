import { describe, expect, test } from "bun:test";

import {
  decodeChatThreadListCursor,
  encodeChatThreadListCursor,
} from "@/api/handlers/chat/thread-list-pagination";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

describe("chat thread list pagination cursor", () => {
  test("roundtrips the updated timestamp and thread id", () => {
    const cursor = encodeChatThreadListCursor({
      id: brandPersistedChatThreadId("018f4ad2-3a6d-7000-8b1d-44f76f5df001"),
      updatedAt: new Date("2026-05-16T08:30:00.000Z"),
    });

    expect(decodeChatThreadListCursor(cursor)).toEqual({
      id: brandPersistedChatThreadId("018f4ad2-3a6d-7000-8b1d-44f76f5df001"),
      updatedAt: new Date("2026-05-16T08:30:00.000Z"),
    });
  });

  test("rejects malformed cursors", () => {
    expect(decodeChatThreadListCursor("not-a-cursor")).toBeNull();
    expect(
      decodeChatThreadListCursor("2026-05-16T08:30:00.000Z|not-a-thread-id"),
    ).toBeNull();
    expect(
      decodeChatThreadListCursor(
        "not-a-date|018f4ad2-3a6d-7000-8b1d-44f76f5df001",
      ),
    ).toBeNull();
  });
});
