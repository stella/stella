import { describe, expect, test } from "bun:test";

import { matchesChatThreadAcrossScopes } from "@/routes/_protected.chat/-queries";

describe("matchesChatThreadAcrossScopes", () => {
  const threadId = "thread-A";

  test("matches the global scope's key for the same thread", () => {
    const key = ["chat", "thread", "global", threadId, false] as const;
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("matches the workspace scope's key for the same thread", () => {
    const key = [
      "chat",
      "thread",
      "workspace",
      "ws-1",
      threadId,
      false,
    ] as const;
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("rejects keys for other threads", () => {
    expect(
      matchesChatThreadAcrossScopes(
        ["chat", "thread", "global", "thread-B", false],
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(
        ["chat", "thread", "workspace", "ws-1", "thread-B", false],
        threadId,
      ),
    ).toBe(false);
  });

  test("rejects non-chat keys", () => {
    expect(
      matchesChatThreadAcrossScopes(
        ["entities", "thread", "global", threadId],
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(["chat", "threads", "global"], threadId),
    ).toBe(false);
  });

  test("rejects keys with an unrecognised scope", () => {
    expect(
      matchesChatThreadAcrossScopes(
        ["chat", "thread", "elsewhere", threadId],
        threadId,
      ),
    ).toBe(false);
  });
});
