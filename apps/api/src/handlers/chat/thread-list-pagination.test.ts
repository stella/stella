import { describe, expect, test } from "bun:test";

import {
  decodeChatThreadListCursor,
  encodeChatThreadListCursor,
} from "@/api/handlers/chat/thread-list-pagination";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

const THREAD_ID = "018f4ad2-3a6d-7000-8b1d-44f76f5df001";

describe("chat thread list pagination cursor", () => {
  test("roundtrips the updated timestamp and thread id", () => {
    const cursor = encodeChatThreadListCursor({
      id: brandPersistedChatThreadId("018f4ad2-3a6d-7000-8b1d-44f76f5df001"),
      updatedAt: "2026-05-16T08:30:00.123456",
    });

    expect(decodeChatThreadListCursor(cursor)).toEqual({
      id: brandPersistedChatThreadId("018f4ad2-3a6d-7000-8b1d-44f76f5df001"),
      updatedAt: "2026-05-16T08:30:00.123456",
    });
  });

  test("preserves sub-millisecond timestamp precision in opaque cursors", () => {
    const cursor = encodeChatThreadListCursor({
      id: brandPersistedChatThreadId("018f4ad2-3a6d-7000-8b1d-44f76f5df001"),
      updatedAt: "2026-05-16T08:30:00.000999",
    });

    expect(cursor).not.toContain("|");
    expect(decodeChatThreadListCursor(cursor)?.updatedAt).toBe(
      "2026-05-16T08:30:00.000999",
    );
  });

  test("accepts an already-issued millisecond timestamp", () => {
    expect(
      decodeChatThreadListCursor(
        encodePaginationCursor(["2026-05-16T08:30:00.000Z", THREAD_ID]),
      ),
    ).toEqual({
      id: brandPersistedChatThreadId(THREAD_ID),
      updatedAt: "2026-05-16T08:30:00.000Z",
    });
  });

  test("rejects malformed cursors", () => {
    expect(decodeChatThreadListCursor("not-a-cursor")).toBeNull();
    // A plain `timestamp|id` string is not a cursor this service issues.
    expect(
      decodeChatThreadListCursor(`2026-05-16T08:30:00.000999|${THREAD_ID}`),
    ).toBeNull();
    for (const parts of [
      ["2026-05-16T08:30:00.000000", "not-a-thread-id"],
      ["not-a-date", THREAD_ID],
      ["2026-02-31T08:30:00.000000", THREAD_ID],
      ["2026-05-16T08:30:00.000000"],
    ]) {
      expect(
        decodeChatThreadListCursor(encodePaginationCursor(parts)),
      ).toBeNull();
    }
  });
});
