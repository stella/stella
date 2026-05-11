import { beforeEach, describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import {
  __resetChatRequestStateForTests,
  buildSendRequestBody,
  chatKeys,
  createSendAutomaticallyPredicate,
  matchesChatThreadAcrossScopes,
} from "@/routes/_protected.chat/-queries";

const createMessage = (id = "message-A"): PersistedChatMessage => ({
  id,
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
  beforeEach(() => {
    __resetChatRequestStateForTests();
  });

  test("includes the preferred send mode from the chat surface", () => {
    const threadId = toChatThreadId("thread-A");
    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key: { scope: "global", threadId },
        messages: [createMessage()],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.anonymized,
      threadId: "thread-A",
    });
  });

  test("preserves a raw override across continuation requests in the same turn", () => {
    const threadId = toChatThreadId("thread-A");
    const key = { scope: "global", threadId } as const;

    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [createMessage()],
        requestBody: { sendMode: CHAT_SEND_MODE.rawOverride },
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: "thread-A",
    });
    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [
          createMessage(),
          {
            id: "assistant-A",
            role: "assistant",
            parts: [
              {
                input: { query: "Acme" },
                output: { content: [] },
                state: "output-available",
                toolCallId: "tool-call-A",
                toolName: "run-stella-query",
                type: "dynamic-tool",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId: "thread-A",
    });
  });

  test("replaces the remembered send mode when the next user turn starts", () => {
    const threadId = toChatThreadId("thread-A");
    const key = { scope: "global", threadId } as const;

    buildSendRequestBody({
      context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
      key,
      messages: [createMessage("message-A")],
      requestBody: { sendMode: CHAT_SEND_MODE.rawOverride },
    });

    expect(
      buildSendRequestBody({
        context: { getSendMode: () => CHAT_SEND_MODE.anonymized },
        key,
        messages: [createMessage("message-A"), createMessage("message-B")],
      }),
    ).toMatchObject({
      sendMode: CHAT_SEND_MODE.anonymized,
      threadId: "thread-A",
    });
  });
});

describe("createSendAutomaticallyPredicate", () => {
  beforeEach(() => {
    __resetChatRequestStateForTests();
  });

  test("allows sequential auto sends inside the same assistant message", () => {
    const shouldSendAutomatically = createSendAutomaticallyPredicate();
    const baseMessage = {
      id: "message-A",
      role: "assistant",
    } satisfies Pick<PersistedChatMessage, "id" | "role">;
    const firstToolResult = {
      ...baseMessage,
      parts: [
        { type: "step-start" },
        {
          input: {},
          output: { content: [] },
          state: "output-available",
          toolCallId: "tool-call-1",
          toolName: "mcp__legaldatahunter-com__discover_countries",
          type: "dynamic-tool",
        },
      ],
    } satisfies PersistedChatMessage;
    const secondApprovalResponse = {
      ...baseMessage,
      parts: [
        ...firstToolResult.parts,
        { type: "step-start" },
        {
          approval: { approved: true, id: "approval-1" },
          input: { query: "derecho al olvido" },
          state: "approval-responded",
          toolCallId: "tool-call-2",
          toolName: "mcp__legaldatahunter-com__search",
          type: "dynamic-tool",
        },
      ],
    } satisfies PersistedChatMessage;

    expect(shouldSendAutomatically({ messages: [firstToolResult] })).toBeTrue();
    expect(
      shouldSendAutomatically({ messages: [firstToolResult] }),
    ).toBeFalse();
    expect(
      shouldSendAutomatically({ messages: [secondApprovalResponse] }),
    ).toBeTrue();
  });
});
