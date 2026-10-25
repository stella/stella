import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  type StoredSession,
} from "@/connection/session";

import {
  appendThreadsPage,
  flattenThreadsPage,
  listChatThreads,
  sectionThreads,
} from "./chat-threads";
import type { ChatThreadSummary } from "./chat-threads";

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

const thread = (id: string, updatedAt: string) => ({
  id,
  title: `Thread ${id}`,
  updatedAt,
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
      source: sourceFor(fetch),
    });
    expect(result.isOk() ? result.value : result.error._tag).toEqual({
      nextCursor: "next-page",
      threads: [
        {
          id: "m1",
          title: "Thread m1",
          updatedAt: "2026-10-21T10:00:00.000Z",
          matterName: "Novák v. Svoboda",
        },
        {
          id: "g1",
          title: "Thread g1",
          updatedAt: "2026-10-20T10:00:00.000Z",
          matterName: undefined,
        },
      ],
    });
    expect(calls).toEqual([
      "https://stella.example.com/v1/chat/threads?cursor=a%20b",
    ]);
  });

  test("a body this build cannot read is an error, not an empty list", async () => {
    const fetch: Fetch = async () => Response.json({ global: [{ id: 7 }] });
    const result = await listChatThreads({ fetch, source: sourceFor(fetch) });
    expect(result.isOk() ? result.value : result.error._tag).toBe(
      "ApiRequestError",
    );
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
    matterName: undefined,
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
