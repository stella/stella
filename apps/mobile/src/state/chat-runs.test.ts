import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_ACTIVE_RUN_STATE,
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
} from "@stll/api-contract/chat";
import type { ChatThreadPinState } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { inboxSections, listActiveChatRuns } from "./chat-runs";
import type { ActiveChatRun } from "./chat-runs";
import type { ChatThreadSummary } from "./chat-threads";

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

const TIME_ZONE = "Europe/Prague";
const NOW = Date.parse("2026-11-10T09:00:00.000Z");

const summary = (
  id: string,
  updatedAt: string,
  {
    matter,
    pinState = CHAT_THREAD_PIN_STATE.unpinned,
  }: {
    matter?: { id: string; name: string };
    pinState?: ChatThreadPinState;
  } = {},
): ChatThreadSummary => ({
  id,
  title: `Thread ${id}`,
  updatedAt,
  matterId: matter?.id,
  matterName: matter?.name,
  pinState,
  readState: CHAT_THREAD_READ_STATE.read,
});

const run = (
  threadId: string,
  state: ActiveChatRun["state"],
  matterId?: string,
): ActiveChatRun => ({
  threadId,
  threadTitle: `Thread ${threadId}`,
  matterId,
  state,
  since: "2026-11-10T08:00:00.000Z",
});

const shape = (sections: ReturnType<typeof inboxSections>) =>
  sections.map(({ data, key }) => [
    key,
    data.map(({ runState, thread }) => [thread.id, runState ?? null]),
  ]);

describe("the chats list as an inbox", () => {
  test("lists chats waiting on the person, then working ones, then pinned ones, then the rest by day", () => {
    const pinned = { pinState: CHAT_THREAD_PIN_STATE.pinned };
    const sections = inboxSections({
      now: NOW,
      runs: [
        run("waiting", CHAT_ACTIVE_RUN_STATE.needsYou),
        run("busy", CHAT_ACTIVE_RUN_STATE.working),
      ],
      searching: false,
      threads: [
        summary("kept", "2026-10-01T07:00:00.000Z", pinned),
        summary("busy", "2026-11-10T08:30:00.000Z", pinned),
        summary("quiet", "2026-11-10T07:00:00.000Z"),
        summary("waiting", "2026-11-01T07:00:00.000Z"),
      ],
      timeZone: TIME_ZONE,
    });
    expect(shape(sections)).toEqual([
      ["needsYou", [["waiting", "needs-you"]]],
      ["working", [["busy", "working"]]],
      ["pinned", [["kept", null]]],
      ["today", [["quiet", null]]],
    ]);
    // A lifted thread keeps its own day, so its row still shows a date.
    expect(sections[0]?.data[0]?.day).toBe("earlier");
  });

  test("lifts a run whose thread is not loaded yet, under the matter name a loaded thread gives", () => {
    const matter = { id: "matter-1", name: "Novák v. Svoboda" };
    const sections = inboxSections({
      now: NOW,
      runs: [run("older", CHAT_ACTIVE_RUN_STATE.needsYou, matter.id)],
      searching: false,
      threads: [summary("recent", "2026-11-10T07:00:00.000Z", { matter })],
      timeZone: TIME_ZONE,
    });
    // Its marks are not known, so the row offers none.
    expect(sections[0]?.data[0]?.type).toBe("run-only");
    expect(sections[0]?.data[0]?.thread).toEqual({
      id: "older",
      title: "Thread older",
      updatedAt: "2026-11-10T08:00:00.000Z",
      matterId: matter.id,
      matterName: matter.name,
    });
  });

  test("a search lifts only the threads it found", () => {
    const sections = inboxSections({
      now: NOW,
      runs: [
        run("found", CHAT_ACTIVE_RUN_STATE.working),
        run("elsewhere", CHAT_ACTIVE_RUN_STATE.needsYou),
      ],
      searching: true,
      threads: [summary("found", "2026-11-10T07:00:00.000Z")],
      timeZone: TIME_ZONE,
    });
    expect(shape(sections)).toEqual([["working", [["found", "working"]]]]);
  });

  test("shows every loaded thread exactly once, open runs first, then pinned ones", () => {
    const ids = ["a", "b", "c", "d", "e", "f"] as const;
    assertProperty(
      "shows every loaded thread exactly once, open runs first, then pinned ones",
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.constantFrom(...ids),
            pinState: fc.constantFrom(...Object.values(CHAT_THREAD_PIN_STATE)),
          }),
          { selector: ({ id }) => id },
        ),
        fc.array(
          fc.record({
            threadId: fc.constantFrom(...ids),
            state: fc.constantFrom(...Object.values(CHAT_ACTIVE_RUN_STATE)),
          }),
        ),
        fc.boolean(),
        fc.integer({ min: 0, max: 30 * 24 * 60 }),
        (loaded, runs, searching, minutesAgo) => {
          const loadedIds = loaded.map(({ id }) => id);
          const threads = loaded.map(({ id, pinState }) =>
            summary(id, new Date(NOW - minutesAgo * 60_000).toISOString(), {
              pinState,
            }),
          );
          const sections = inboxSections({
            now: NOW,
            runs: runs.map(({ state, threadId }) => run(threadId, state)),
            searching,
            threads,
            timeZone: TIME_ZONE,
          });
          const shown = sections.flatMap(({ data }) =>
            data.map(({ thread }) => thread.id),
          );
          expect(new Set(shown).size).toBe(shown.length);
          // The first run listed for a thread decides its state.
          const stateOf = new Map<string, ActiveChatRun["state"]>();
          for (const { state, threadId } of runs) {
            if (!stateOf.has(threadId)) {
              stateOf.set(threadId, state);
            }
          }
          const expected = new Set([
            ...loadedIds,
            ...[...stateOf.keys()].filter(
              (id) =>
                !searching || loadedIds.some((loadedId) => loadedId === id),
            ),
          ]);
          expect(new Set(shown)).toEqual(expected);
          // Sections come in one order: open runs, pinned, then by day.
          const rank = (key: (typeof sections)[number]["key"]) => {
            switch (key) {
              case "needsYou":
              case "working":
                return 0;
              case "pinned":
                return 1;
              case "today":
              case "yesterday":
              case "week":
              case "earlier":
                return 2;
              default:
                key satisfies never;
                return panic("unknown inbox section");
            }
          };
          const ranks = sections.map(({ key }) => rank(key));
          expect(ranks).toEqual(ranks.toSorted((left, right) => left - right));
          const isPinned = (threadId: string) =>
            loaded.some(
              ({ id, pinState }) =>
                id === threadId && pinState === CHAT_THREAD_PIN_STATE.pinned,
            );
          for (const { data, key } of sections) {
            for (const row of data) {
              const { runState, thread } = row;
              const open = stateOf.get(thread.id);
              expect(runState ?? null).toBe(
                rank(key) === 0 ? (open ?? null) : null,
              );
              // A chat with an open run heads the list even when pinned;
              // otherwise a pinned chat is under Pinned and nowhere else.
              expect(key === "pinned").toBe(
                open === undefined && isPinned(thread.id),
              );
              // Only a thread the list did not read is shown without marks.
              expect(row.type === "run-only").toBe(
                !loadedIds.some((id) => id === thread.id),
              );
            }
          }
        },
      ),
    );
  });
});

describe("reading unfinished runs", () => {
  test("reads every page and leaves out a state this build cannot draw", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      calls.push(input);
      const first = !input.includes("cursor=");
      return Response.json({
        items: [
          {
            threadId: first ? "t1" : "t2",
            threadTitle: "Lease review",
            workspaceId: first ? "matter-1" : null,
            state: first ? "needs-you" : "working",
            since: "2026-11-10T08:00:00.000Z",
          },
          ...(first
            ? []
            : [
                {
                  threadId: "t3",
                  threadTitle: "Later",
                  workspaceId: null,
                  state: "paused",
                  since: "2026-11-10T08:00:00.000Z",
                },
              ]),
        ],
        nextCursor: first ? "page 2" : null,
      });
    };
    const read = await listActiveChatRuns({ fetch, source: sourceFor(fetch) });
    expect(Result.isOk(read) ? read.value : read.error).toEqual([
      {
        matterId: "matter-1",
        since: "2026-11-10T08:00:00.000Z",
        state: "needs-you",
        threadId: "t1",
        threadTitle: "Lease review",
      },
      {
        matterId: undefined,
        since: "2026-11-10T08:00:00.000Z",
        state: "working",
        threadId: "t2",
        threadTitle: "Lease review",
      },
    ]);
    expect(calls).toEqual([
      "https://stella.example.com/v1/chat/runs/active?limit=100",
      "https://stella.example.com/v1/chat/runs/active?limit=100&cursor=page%202",
    ]);
  });

  test("a cursor the server already gave fails the read instead of looping", async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      return Response.json({
        items: [],
        nextCursor: "page 2",
      });
    };
    const read = await listActiveChatRuns({ fetch, source: sourceFor(fetch) });
    expect(Result.isError(read)).toBe(true);
    expect(calls).toBe(2);
  });

  test("a refused read is a failure, not an empty list", async () => {
    const fetch: Fetch = async () =>
      Response.json({ message: "Forbidden" }, { status: 403 });
    const read = await listActiveChatRuns({ fetch, source: sourceFor(fetch) });
    expect(Result.isError(read)).toBe(true);
  });
});
