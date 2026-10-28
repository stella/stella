import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import {
  messagesQuery,
  prependOlderPage,
  readChatThread,
  readOlderChatMessages,
  toChatEntry,
} from "./chat-messages";
import type { ChatEntry } from "./chat-messages";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
};

const sourceFor = (fetch: Fetch) =>
  createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });

const CREATED_AT = "2026-10-20T10:00:00.000Z";

describe("what a thread shows of a stored message", () => {
  test("joins its text parts and names the tools it called", () => {
    expect(
      toChatEntry({
        id: "m1",
        role: "assistant",
        createdAt: CREATED_AT,
        parts: [
          { type: "thinking", content: "private reasoning" },
          { type: "tool-call", name: "search_case_law", arguments: "{}" },
          { type: "text", content: "First.  " },
          { type: "text", content: "Second." },
          { type: "image", source: { type: "url", value: "x" } },
        ],
      }),
    ).toEqual({
      id: "m1",
      role: "assistant",
      createdAt: CREATED_AT,
      text: "First.\n\nSecond.",
      tools: ["search_case_law"],
    });
  });

  test("leaves out system messages and messages with nothing to draw", () => {
    expect(
      toChatEntry({
        id: "s",
        role: "system",
        createdAt: CREATED_AT,
        parts: [{ type: "text", content: "instructions" }],
      }),
    ).toBeUndefined();
    expect(
      toChatEntry({
        id: "e",
        role: "user",
        createdAt: CREATED_AT,
        parts: [{ type: "document", source: {} }],
      }),
    ).toBeUndefined();
  });
});

describe("reading a thread", () => {
  test("reads the latest page, then the page before its cursor", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      calls.push(input);
      return Response.json({
        messages: [
          {
            id: input.includes("older") ? "m0" : "m1",
            role: "user",
            createdAt: CREATED_AT,
            edited: false,
            revision: 1,
            parts: [{ type: "text", content: "Hello" }],
          },
        ],
        olderCursor: input.includes("older") ? null : "cursor/1",
        // The rest of the thread's state rides along and is ignored.
        activeTurnId: null,
        threadExists: true,
      });
    };
    const source = sourceFor(fetch);
    const latest = await readChatThread({
      fetch,
      matterId: "matter 1",
      source,
      threadId: "t 1",
    });
    expect(latest.isOk() ? latest.value.olderCursor : latest.error._tag).toBe(
      "cursor/1",
    );
    const older = await readOlderChatMessages({
      before: "cursor/1",
      fetch,
      matterId: "matter 1",
      source,
      threadId: "t 1",
    });
    expect(
      older.isOk() ? older.value.entries.map(({ id }) => id) : older.error._tag,
    ).toEqual(["m0"]);
    expect(calls).toEqual([
      "https://stella.example.com/v1/chat/threads/t%201/messages?workspaceId=matter%201",
      "https://stella.example.com/v1/chat/threads/t%201/messages/older?before=cursor%2F1&workspaceId=matter%201",
    ]);
  });

  test("says whether the thread has sent anonymized text", async () => {
    const pageFor =
      (usedAnonymization?: boolean): Fetch =>
      async () =>
        Response.json({
          messages: [],
          olderCursor: null,
          activeTurnId: null,
          ...(usedAnonymization === undefined ? {} : { usedAnonymization }),
        });
    const read = async (fetch: Fetch) => {
      const page = await readChatThread({
        fetch,
        matterId: undefined,
        source: sourceFor(fetch),
        threadId: "t1",
      });
      return page.isOk() ? page.value.usedAnonymization : page.error._tag;
    };
    expect(await read(pageFor(true))).toBe(true);
    expect(await read(pageFor(false))).toBe(false);
    // A server from before the field reads as a thread that never anonymized.
    expect(await read(pageFor(undefined))).toBe(false);
  });

  test("a global thread is read without a matter", () => {
    expect(messagesQuery({ matterId: undefined })).toBe("");
    expect(messagesQuery({ before: "c", matterId: undefined })).toBe(
      "?before=c",
    );
  });

  test("an older page goes in front, without a message twice", () => {
    const entry = (id: string): ChatEntry => ({
      id,
      role: "user",
      createdAt: CREATED_AT,
      text: id,
      tools: [],
    });
    expect(
      prependOlderPage(
        [entry("c"), entry("d")],
        [entry("a"), entry("b"), entry("c")],
      ).map(({ id }) => id),
    ).toEqual(["a", "b", "c", "d"]);
  });
});
