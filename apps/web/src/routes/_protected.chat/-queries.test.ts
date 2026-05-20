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
  mergeGroupedChatThreadPages,
} from "@/routes/_protected.chat/-queries";

const createMessage = (id = "message-A"): PersistedChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "Hello" }],
});
const date = (value: string): Date => new Date(value);

describe("chatKeys", () => {
  test("separates plain chat transports from active DOCX edit transports", () => {
    const threadId = toChatThreadId("thread-A");
    const base = {
      allowMissingThread: true,
      scope: "workspace",
      threadId,
      workspaceId: "ws-1",
    } as const;

    expect(chatKeys.thread("org_test", base)).toEqual(
      chatKeys.thread("org_test", { ...base, contextKind: "plain" }),
    );
    expect(
      chatKeys.thread("org_test", { ...base, contextKind: "plain" }),
    ).not.toEqual(
      chatKeys.thread("org_test", { ...base, contextKind: "active-docx-edit" }),
    );
  });
});

describe("matchesChatThreadAcrossScopes", () => {
  const threadId = toChatThreadId("thread-A");
  const otherThreadId = toChatThreadId("thread-B");

  test("matches the global scope's key for the same thread", () => {
    const key = chatKeys.thread("org_test", { scope: "global", threadId });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("matches the workspace scope's key for the same thread", () => {
    const key = chatKeys.thread("org_test", {
      scope: "workspace",
      workspaceId: "ws-1",
      threadId,
    });
    expect(matchesChatThreadAcrossScopes(key, threadId)).toBe(true);
  });

  test("rejects keys for other threads", () => {
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread("org_test", {
          scope: "global",
          threadId: otherThreadId,
        }),
        threadId,
      ),
    ).toBe(false);
    expect(
      matchesChatThreadAcrossScopes(
        chatKeys.thread("org_test", {
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

describe("mergeGroupedChatThreadPages", () => {
  test("deduplicates threads while appending workspace groups across pages", () => {
    const result = mergeGroupedChatThreadPages([
      {
        global: [
          {
            createdAt: date("2026-05-16T08:00:00.000Z"),
            id: "global-A",
            title: "Global A",
            updatedAt: date("2026-05-16T08:00:00.000Z"),
          },
        ],
        nextCursor: "page-2",
        workspaces: [
          {
            workspaceId: "workspace-A",
            workspaceName: "Matter A",
            threads: [
              {
                createdAt: date("2026-05-16T07:00:00.000Z"),
                id: "workspace-thread-A",
                title: "Workspace A",
                updatedAt: date("2026-05-16T07:00:00.000Z"),
              },
            ],
          },
        ],
      },
      {
        global: [
          {
            createdAt: date("2026-05-16T08:00:00.000Z"),
            id: "global-A",
            title: "Global A duplicate",
            updatedAt: date("2026-05-16T08:00:00.000Z"),
          },
          {
            createdAt: date("2026-05-16T06:00:00.000Z"),
            id: "global-B",
            title: "Global B",
            updatedAt: date("2026-05-16T06:00:00.000Z"),
          },
        ],
        nextCursor: null,
        workspaces: [
          {
            workspaceId: "workspace-A",
            workspaceName: "Matter A",
            threads: [
              {
                createdAt: date("2026-05-16T07:00:00.000Z"),
                id: "workspace-thread-A",
                title: "Workspace A duplicate",
                updatedAt: date("2026-05-16T07:00:00.000Z"),
              },
              {
                createdAt: date("2026-05-16T05:00:00.000Z"),
                id: "workspace-thread-B",
                title: "Workspace B",
                updatedAt: date("2026-05-16T05:00:00.000Z"),
              },
            ],
          },
          {
            workspaceId: "workspace-B",
            workspaceName: "Matter B",
            threads: [
              {
                createdAt: date("2026-05-16T04:00:00.000Z"),
                id: "workspace-thread-C",
                title: "Workspace C",
                updatedAt: date("2026-05-16T04:00:00.000Z"),
              },
            ],
          },
        ],
      },
    ]);

    expect(result.global.map((thread) => thread.id)).toEqual([
      "global-A",
      "global-B",
    ]);
    expect(result.workspaces).toMatchObject([
      {
        workspaceId: "workspace-A",
        threads: [{ id: "workspace-thread-A" }, { id: "workspace-thread-B" }],
      },
      {
        workspaceId: "workspace-B",
        threads: [{ id: "workspace-thread-C" }],
      },
    ]);
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
