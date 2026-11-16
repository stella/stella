import { describe, expect, test } from "bun:test";

import {
  CHAT_SEND_QUEUES_INSTEAD_CODE,
  QUEUED_MESSAGE_FILES_ON_REMOVE,
} from "@stll/api-contract/chat-queue";
import { DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH } from "@stll/api-contract/desktop-runner";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import { ApiRequestError } from "@/state/api-request";
import {
  queuedMessageText,
  queuesInstead,
  removeQueuedChatMessage,
  steerableQueuedText,
} from "@/state/chat-queue";
import { chatSendBody, queuedChatSend } from "@/state/chat-stream";

const refused = (code: string | undefined) =>
  new ApiRequestError({ message: "refused", status: 409, code });

describe("a send the server refused", () => {
  test("is queued for each code that says the thread is busy, and only then", () => {
    for (const code of Object.values(CHAT_SEND_QUEUES_INSTEAD_CODE)) {
      expect({ code, queues: queuesInstead(refused(code)) }).toEqual({
        code,
        queues: true,
      });
    }
    expect(queuesInstead(refused("chat_history_changed"))).toBe(false);
    expect(queuesInstead(refused(undefined))).toBe(false);
  });

  test("is queued as the send forwards it, without its thread and run", () => {
    const message = {
      anonymized: true,
      matterId: "0198c0de-0000-7000-8000-0000000000aa",
      messageId: "0198c0de-0000-7000-8000-0000000000bb",
      text: "Check the annex.",
    };
    const { threadId, runId, ...forwarded } = chatSendBody({
      ...message,
      runId: "0198c0de-0000-7000-8000-0000000000cc",
      threadId: "0198c0de-0000-7000-8000-0000000000dd",
    }).forwardedProps;
    expect({ threadId, runId }).toEqual({
      threadId: "0198c0de-0000-7000-8000-0000000000dd",
      runId: "0198c0de-0000-7000-8000-0000000000cc",
    });
    expect(queuedChatSend(message)).toEqual(forwarded);
  });
});

describe("a queued message", () => {
  const text = (content: string) => ({ type: "text", content });

  test("goes back to the composer or to a running turn only as text", () => {
    expect(queuedMessageText([text("First."), text("Second.")])).toBe(
      "First.\n\nSecond.",
    );
    expect(
      queuedMessageText([text("See the file."), { type: "document" }]),
    ).toBeNull();
    expect(queuedMessageText([text("  ")])).toBeNull();
  });

  test("is handed to a running turn only raw and within one steer", () => {
    const parts = [text("Also check the annex.")];
    expect(steerableQueuedText({ parts, sendMode: "rawOverride" })).toBe(
      "Also check the annex.",
    );
    expect(steerableQueuedText({ parts, sendMode: "anonymized" })).toBeNull();
    expect(
      steerableQueuedText({
        parts: [text("a".repeat(DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH + 1))],
        sendMode: "rawOverride",
      }),
    ).toBeNull();
  });
});

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

describe("removing a queued message", () => {
  test("names the revision read and what becomes of its stored files", async () => {
    const routes: string[] = [];
    const fetch: Fetch = async (input, init) => {
      routes.push(
        `${init?.method ?? "GET"} ${input.replace(SESSION.serverUrl, "")}`,
      );
      return Response.json({ message: {} });
    };
    const store = createSessionStore({
      read: async () => SESSION,
      write: async () => {},
      prepareClear: async () => {},
      clear: async () => {},
    });
    const source = createAccessTokenSource({
      fetch,
      initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
      now: () => 0,
      session: SESSION,
      generation: store.generation(),
      store,
    });
    for (const files of Object.values(QUEUED_MESSAGE_FILES_ON_REMOVE)) {
      const removed = await removeQueuedChatMessage({
        fetch,
        files,
        messageId: "m-1",
        revision: 3,
        source,
        threadId: "t-1",
      });
      expect(removed.isOk()).toBe(true);
    }
    expect(routes).toEqual(
      Object.values(QUEUED_MESSAGE_FILES_ON_REMOVE).map(
        (files) =>
          `DELETE /v1/chat/threads/t-1/queue/m-1?files=${files}&revision=3`,
      ),
    );
  });
});
