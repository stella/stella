import { describe, expect, test } from "bun:test";

import {
  mergeRecentChatThreadPages,
  parseRecentChatThreadsPage,
} from "./recent-chat-threads";

const FIRST_THREAD_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const THIRD_THREAD_ID = "00000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000010";

const thread = (id: string, updatedAt: string, title: string) => ({
  createdAt: "2026-07-01T08:00:00.000Z",
  id,
  title,
  updatedAt,
});

describe("recent chat thread pages", () => {
  test("merges, deduplicates, and restores recency across API groups", () => {
    const firstPage = parseRecentChatThreadsPage({
      global: [
        thread(FIRST_THREAD_ID, "2026-07-22T08:00:00.000Z", "First page"),
      ],
      nextCursor: "next",
      workspaces: [
        {
          threads: [
            thread(
              SECOND_THREAD_ID,
              "2026-07-22T10:00:00.000Z",
              "Workspace chat",
            ),
          ],
          workspaceId: WORKSPACE_ID,
          workspaceName: "Matter Alpha",
        },
      ],
    });
    const secondPage = parseRecentChatThreadsPage({
      global: [
        thread(FIRST_THREAD_ID, "2026-07-21T08:00:00.000Z", "Stale copy"),
        thread(THIRD_THREAD_ID, "2026-07-20T08:00:00.000Z", "Older chat"),
      ],
      nextCursor: null,
      workspaces: [],
    });

    expect(mergeRecentChatThreadPages([firstPage, secondPage])).toEqual([
      {
        id: SECOND_THREAD_ID,
        scope: "workspace",
        title: "Workspace chat",
        updatedAt: "2026-07-22T10:00:00.000Z",
        workspaceId: WORKSPACE_ID,
        workspaceName: "Matter Alpha",
      },
      {
        id: FIRST_THREAD_ID,
        scope: "global",
        title: "First page",
        updatedAt: "2026-07-22T08:00:00.000Z",
      },
      {
        id: THIRD_THREAD_ID,
        scope: "global",
        title: "Older chat",
        updatedAt: "2026-07-20T08:00:00.000Z",
      },
    ]);
  });

  test("rejects invalid timestamps at the network boundary", () => {
    expect(() =>
      parseRecentChatThreadsPage({
        global: [thread(FIRST_THREAD_ID, "not-a-date", "Broken")],
        nextCursor: null,
        workspaces: [],
      }),
    ).toThrow();
  });

  test("rejects unexpected response fields instead of silently ignoring drift", () => {
    expect(() =>
      parseRecentChatThreadsPage({
        global: [],
        nextCursor: null,
        unexpected: true,
        workspaces: [],
      }),
    ).toThrow();
  });
});
