import { describe, expect, test } from "bun:test";

import type { ChatLimitReminderResponse } from "@stll/api-contract/chat-limit-reminder";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import {
  cancelChatLimitReminder,
  readChatLimitReminder,
  setChatLimitReminder,
  storedLimitResetsAt,
} from "@/state/chat-limit-reminder";
import { toChatEntry } from "@/state/chat-messages";

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

const RESETS_AT = "2026-11-16T15:30:00.000Z";

/** A signed-in phone whose server answers every request with `answer`. */
const phoneAnswering = (answer: ChatLimitReminderResponse) => {
  const sent: { route: string; body: unknown }[] = [];
  const fetch: Fetch = async (input, init) => {
    sent.push({
      route: `${init?.method ?? "GET"} ${input.replace(SESSION.serverUrl, "")}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(answer);
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
  return { fetch, sent, source };
};

describe("what happens when a chat's usage limit resets", () => {
  test("is asked for, read and cancelled on the web's routes, naming the thread's matter", async () => {
    const armed = {
      remindAt: RESETS_AT,
      onReset: "continue",
    } as const satisfies ChatLimitReminderResponse;
    const { fetch, sent, source } = phoneAnswering(armed);
    const thread = {
      fetch,
      matterId: "0198c0de-0000-7000-8000-0000000000aa",
      source,
      threadId: "t-1",
    };

    const set = await setChatLimitReminder({ ...thread, onReset: "continue" });
    const read = await readChatLimitReminder(thread);

    expect(set.isOk() && set.value).toEqual(armed);
    expect(read.isOk() && read.value).toEqual(armed);
    const route =
      "/v1/chat/threads/t-1/limit-reminder?workspaceId=0198c0de-0000-7000-8000-0000000000aa";
    expect(sent).toEqual([
      { route: `PUT ${route}`, body: { onReset: "continue" } },
      { route: `GET ${route}`, body: undefined },
    ]);
  });

  test("reads as nothing asked once cancelled, for a chat outside a matter", async () => {
    const { fetch, sent, source } = phoneAnswering({ remindAt: null });

    const cancelled = await cancelChatLimitReminder({
      fetch,
      matterId: undefined,
      source,
      threadId: "t-2",
    });

    expect(cancelled.isOk() && cancelled.value).toEqual({ remindAt: null });
    expect(sent.map(({ route }) => route)).toEqual([
      "DELETE /v1/chat/threads/t-2/limit-reminder",
    ]);
  });
});

describe("a stored answer stopped by a usage limit", () => {
  const answer = (turnOutcome: unknown) => ({
    id: "a-1",
    role: "assistant" as const,
    createdAt: "2026-11-16T14:00:00.000Z",
    parts: [],
    metadata: { turnOutcome },
  });

  test("carries when the limit resets, and any other failure does not", () => {
    const limited = {
      type: "failed",
      error: "local_runner_limit_reached",
      limitResetsAt: RESETS_AT,
    };
    expect(storedLimitResetsAt({ turnOutcome: limited })).toBe(RESETS_AT);
    expect(toChatEntry(answer(limited))).toMatchObject({
      failure: "local_runner_limit_reached",
      limitResetsAt: RESETS_AT,
    });

    const unknownReset = {
      type: "failed",
      error: "local_runner_limit_reached",
    };
    const otherFailure = {
      type: "failed",
      error: "provider_unavailable",
      limitResetsAt: RESETS_AT,
    };
    for (const outcome of [unknownReset, otherFailure]) {
      const entry = toChatEntry(answer(outcome));
      expect(entry?.failure).toBeDefined();
      expect(entry?.limitResetsAt).toBeUndefined();
    }
  });
});
