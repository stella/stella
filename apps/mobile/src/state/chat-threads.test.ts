import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import {
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
} from "@stll/api-contract/chat";
import type { ChatThreadPinState } from "@stll/api-contract/chat";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import {
  appendThreadsPage,
  flattenThreadsPage,
  listChats,
  listChatThreads,
  nextChatsPage,
  sectionThreads,
  setChatThreadPinState,
  setChatThreadReadState,
  threadsQuery,
} from "./chat-threads";
import type { ChatListCursors, ChatThreadSummary } from "./chat-threads";

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

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    store,
    generation: store.generation(),
  });
};

const thread = (
  id: string,
  updatedAt: string,
  pinState: ChatThreadPinState = CHAT_THREAD_PIN_STATE.unpinned,
) => ({
  id,
  title: `Thread ${id}`,
  updatedAt,
  readState: CHAT_THREAD_READ_STATE.unread,
  pinState,
  // Fields the app does not show ride along and are ignored.
  createdAt: updatedAt,
  usedAnonymization: false,
  origin: "original",
  decision: null,
});

describe("listing chat threads", () => {
  test("merges global and matter threads into one timeline, newest first", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      calls.push(input);
      return Response.json({
        global: [thread("g1", "2026-10-20T10:00:00.000Z")],
        nextCursor: "next-page",
        workspaces: [
          {
            workspaceId: "matter-1",
            workspaceName: "Novák v. Svoboda",
            threads: [thread("m1", "2026-10-21T10:00:00.000Z")],
          },
        ],
      });
    };
    const result = await listChatThreads({
      cursor: "a b",
      fetch,
      pinState: CHAT_THREAD_PIN_STATE.unpinned,
      source: sourceFor(fetch),
    });
    expect(result.isOk() ? result.value : result.error._tag).toEqual({
      nextCursor: "next-page",
      threads: [
        {
          id: "m1",
          title: "Thread m1",
          updatedAt: "2026-10-21T10:00:00.000Z",
          matterId: "matter-1",
          matterName: "Novák v. Svoboda",
          pinState: "unpinned",
          readState: "unread",
        },
        {
          id: "g1",
          title: "Thread g1",
          updatedAt: "2026-10-20T10:00:00.000Z",
          matterId: undefined,
          matterName: undefined,
          pinState: "unpinned",
          readState: "unread",
        },
      ],
    });
    expect(calls).toEqual([
      "https://stella.example.com/v1/chat/threads?pinState=unpinned&cursor=a%20b",
    ]);
  });

  test("asks for the typed text, trimmed, and keeps it on later pages", () => {
    const { pinned, unpinned } = CHAT_THREAD_PIN_STATE;
    expect(threadsQuery({ pinState: undefined })).toBe("");
    expect(threadsQuery({ pinState: pinned })).toBe("?pinState=pinned");
    expect(threadsQuery({ pinState: unpinned, search: "   " })).toBe(
      "?pinState=unpinned",
    );
    expect(threadsQuery({ pinState: pinned, search: " lease & rent " })).toBe(
      "?pinState=pinned&search=lease%20%26%20rent",
    );
    expect(
      threadsQuery({ cursor: "c 1", pinState: unpinned, search: "Novák" }),
    ).toBe("?pinState=unpinned&search=Nov%C3%A1k&cursor=c%201");
  });

  test("a body this build cannot read is an error, not an empty list", async () => {
    const fetch: Fetch = async () => Response.json({ global: [{ id: 7 }] });
    const result = await listChatThreads({
      fetch,
      pinState: CHAT_THREAD_PIN_STATE.unpinned,
      source: sourceFor(fetch),
    });
    expect(result.isOk() ? result.value : result.error._tag).toBe(
      "ApiRequestError",
    );
  });

  test("a load reads the pinned chats and the rest, two requests, pinned first", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      calls.push(input);
      const pinned = input.includes("pinState=pinned");
      return Response.json({
        global: [
          pinned
            ? thread("p", "2026-09-01T10:00:00.000Z", "pinned")
            : thread("u", "2026-10-21T10:00:00.000Z"),
        ],
        nextCursor: pinned ? null : "more",
        workspaces: [],
      });
    };
    const result = await listChats({
      fetch,
      search: "lease",
      source: sourceFor(fetch),
    });
    expect(
      result.isOk()
        ? {
            cursors: result.value.cursors,
            ids: result.value.threads.map(({ id }) => id),
          }
        : result.error._tag,
    ).toEqual({ cursors: { pinned: null, unpinned: "more" }, ids: ["p", "u"] });
    expect(calls.toSorted()).toEqual([
      "https://stella.example.com/v1/chat/threads?pinState=pinned&search=lease",
      "https://stella.example.com/v1/chat/threads?pinState=unpinned&search=lease",
    ]);
  });

  test("a load whose pinned read fails is a failure, not a list without them", async () => {
    const fetch: Fetch = async (input) =>
      input.includes("pinState=pinned")
        ? Response.json({ message: "Unavailable" }, { status: 503 })
        : Response.json({ global: [], nextCursor: null, workspaces: [] });
    const result = await listChats({ fetch, source: sourceFor(fetch) });
    expect(result.isOk() ? result.value : result.error._tag).toBe(
      "ApiRequestError",
    );
  });

  test("later pages finish the pinned chats before the rest, then stop", () => {
    // Each page's own next cursor, as the server would answer it.
    const ends = new Map([
      ["p2", "p3"],
      ["p3", null],
      ["u2", null],
    ]);
    const readAll = (cursors: ChatListCursors): string[] => {
      const page = nextChatsPage(cursors);
      return page === null
        ? []
        : [
            `${page.pinState}:${page.cursor}`,
            ...readAll(page.after(ends.get(page.cursor) ?? null)),
          ];
    };
    expect(readAll({ pinned: "p2", unpinned: "u2" })).toEqual([
      "pinned:p2",
      "pinned:p3",
      "unpinned:u2",
    ]);
  });

  test("a thread that moved onto the next page is shown once", () => {
    const first = flattenThreadsPage({
      global: [thread("a", "2026-10-21T10:00:00.000Z")],
      nextCursor: "c",
      workspaces: [],
    }).threads;
    const next = flattenThreadsPage({
      global: [
        thread("a", "2026-10-21T10:00:00.000Z"),
        thread("b", "2026-10-20T10:00:00.000Z"),
      ],
      nextCursor: null,
      workspaces: [],
    }).threads;
    expect(appendThreadsPage(first, next).map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("sectioning threads by day", () => {
  const TIME_ZONE = "Europe/Prague";
  const zoned = (day: number, hour: number) =>
    Temporal.ZonedDateTime.from({
      year: 2026,
      month: 10,
      day,
      hour,
      timeZone: TIME_ZONE,
    });
  const at = (day: number, hour: number) =>
    zoned(day, hour).toInstant().toString();
  // The clocks go back in Prague early on the 25th, so "today" is a
  // 25-hour day here and still starts at its own midnight.
  const now = zoned(25, 9).epochMilliseconds;
  const summary = (id: string, updatedAt: string): ChatThreadSummary => ({
    id,
    title: id,
    updatedAt,
    matterId: undefined,
    matterName: undefined,
    pinState: CHAT_THREAD_PIN_STATE.unpinned,
    readState: CHAT_THREAD_READ_STATE.read,
  });

  test("puts each thread under today, yesterday, the previous week or earlier", () => {
    const sections = sectionThreads(
      [
        summary("this-morning", at(25, 1)),
        summary("last-night", at(24, 23)),
        summary("monday", at(19, 12)),
        summary("last-month", at(1, 12)),
      ],
      now,
      TIME_ZONE,
    );
    expect(
      sections.map(({ key, data }) => [key, data.map(({ id }) => id)]),
    ).toEqual([
      ["today", ["this-morning"]],
      ["yesterday", ["last-night"]],
      ["week", ["monday"]],
      ["earlier", ["last-month"]],
    ]);
  });

  test("leaves out empty sections", () => {
    expect(
      sectionThreads([summary("old", at(1, 12))], now, TIME_ZONE).map(
        ({ key }) => key,
      ),
    ).toEqual(["earlier"]);
    expect(sectionThreads([], now, TIME_ZONE)).toEqual([]);
  });
});

describe("marking a chat", () => {
  test("names a matter chat's matter and sends the new state", async () => {
    const calls: { body: unknown; method: string | undefined; url: string }[] =
      [];
    const fetch: Fetch = async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        method: init?.method,
        url: input,
      });
      return Response.json({});
    };
    const source = sourceFor(fetch);
    const read = await setChatThreadReadState({
      fetch,
      matterId: "matter 1",
      readState: CHAT_THREAD_READ_STATE.read,
      source,
      threadId: "t/1",
    });
    const pin = await setChatThreadPinState({
      fetch,
      matterId: undefined,
      pinState: CHAT_THREAD_PIN_STATE.pinned,
      source,
      threadId: "t2",
    });
    expect([read.isOk(), pin.isOk()]).toEqual([true, true]);
    expect(calls).toEqual([
      {
        body: { readState: "read" },
        method: "PATCH",
        url: "https://stella.example.com/v1/chat/threads/t%2F1/read-state?workspaceId=matter%201",
      },
      {
        body: { pinState: "pinned" },
        method: "PATCH",
        url: "https://stella.example.com/v1/chat/threads/t2/pin-state",
      },
    ]);
  });

  test("a refused mark is a failure", async () => {
    const fetch: Fetch = async () =>
      Response.json({ message: "Forbidden" }, { status: 403 });
    const result = await setChatThreadPinState({
      fetch,
      matterId: undefined,
      pinState: CHAT_THREAD_PIN_STATE.unpinned,
      source: sourceFor(fetch),
      threadId: "t1",
    });
    expect(result.isErr()).toBe(true);
  });
});
