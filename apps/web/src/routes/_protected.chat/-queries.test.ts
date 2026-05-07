import { describe, expect, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import {
  buildSendRequestBody,
  chatKeys,
  matchesChatThreadAcrossScopes,
} from "@/routes/_protected.chat/-queries";

const createMessage = (): PersistedChatMessage => ({
  id: "message-A",
  role: "user",
  parts: [{ type: "text", text: "Hello" }],
});

describe("chatKeys", () => {
  test("separates plain chat transports from active DOCX edit transports", () => {
    const threadId = toChatThreadId("thread-A");
    const base = {
      allowMissingThread: true,
      scope: "workspace",
      threadId,
      workspaceId: "ws-1",
    } as const;

    expect(chatKeys.thread(base)).toEqual(
      chatKeys.thread({ ...base, contextKind: "plain" }),
    );
    expect(chatKeys.thread({ ...base, contextKind: "plain" })).not.toEqual(
      chatKeys.thread({ ...base, contextKind: "active-docx-edit" }),
    );
  });
});

describe("matchesChatThreadAcrossScopes", () => {
  const threadId = toChatThreadId("thread-A");
  const otherThreadId = toChatThreadId("thread-B");

  test("matches the global scope's key for the same thread", () => {
    const key = chatKeys.thread({ scope: "global", threadId });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("matches the workspace scope's key for the same thread", () => {
    const key = chatKeys.thread({
      scope: "workspace",
      workspaceId: "ws-1",
      threadId,
    });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("rejects keys for other threads", () => {
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread({ scope: "global", threadId: otherThreadId }),
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread({
          scope: "workspace",
          workspaceId: "ws-1",
          threadId: otherThreadId,
        }),
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

describe("buildSendRequestBody", () => {
  test("includes anonymized mode when the chat surface enables it", () => {
    const threadId = toChatThreadId("thread-A");
    expect(
      buildSendRequestBody({
        context: { getAnonymized: () => true },
        key: { scope: "global", threadId },
        messages: [createMessage()],
      }),
    ).toMatchObject({
      anonymized: true,
      threadId: "thread-A",
    });
  });
});
