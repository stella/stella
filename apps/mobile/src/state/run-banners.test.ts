import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import type { ActiveChatRun } from "./chat-runs";
import { queueRunBanners, RUN_BANNER_TYPE, runBanners } from "./run-banners";

const THREAD_IDS = ["a", "b", "c", "d", "e"] as const;

const run = (
  threadId: string,
  state: ActiveChatRun["state"],
): ActiveChatRun => ({
  matterId: undefined,
  since: "2026-11-10T08:00:00.000Z",
  state,
  threadId,
  threadTitle: `Thread ${threadId}`,
});

/** A read of the unfinished runs, several runs per thread allowed. */
const snapshot = fc
  .array(
    fc.record({
      state: fc.constantFrom(...Object.values(CHAT_ACTIVE_RUN_STATE)),
      threadId: fc.constantFrom(...THREAD_IDS),
    }),
    { maxLength: 8 },
  )
  .map((runs) => runs.map(({ state, threadId }) => run(threadId, state)));

/** The state the chats list shows for each thread in a read. */
const shownState = (runs: readonly ActiveChatRun[]) => {
  const states = new Map<string, ActiveChatRun["state"]>();
  for (const { state, threadId } of runs) {
    if (!states.has(threadId)) {
      states.set(threadId, state);
    }
  }
  return states;
};

const shape = (banners: ReturnType<typeof runBanners>) =>
  banners.map(({ threadId, type }) => [threadId, type]);

describe("banners for chat runs", () => {
  test("a run that comes to wait on the reader, and one that leaves the list", () => {
    expect(
      shape(
        runBanners({
          previous: [
            run("a", CHAT_ACTIVE_RUN_STATE.working),
            run("b", CHAT_ACTIVE_RUN_STATE.needsYou),
            run("c", CHAT_ACTIVE_RUN_STATE.working),
          ],
          next: [
            run("a", CHAT_ACTIVE_RUN_STATE.needsYou),
            run("b", CHAT_ACTIVE_RUN_STATE.working),
            run("d", CHAT_ACTIVE_RUN_STATE.needsYou),
          ],
        }),
      ),
    ).toEqual([
      ["a", RUN_BANNER_TYPE.needsYou],
      ["d", RUN_BANNER_TYPE.needsYou],
      ["c", RUN_BANNER_TYPE.finished],
    ]);
  });

  test("no banner on the first snapshot", () => {
    assertProperty(
      "no banner on the first snapshot",
      fc.property(snapshot, (next) => {
        expect(runBanners({ next, previous: undefined })).toEqual([]);
      }),
    );
  });

  test("each transition produces at most one banner", () => {
    assertProperty(
      "each transition produces at most one banner",
      fc.property(snapshot, snapshot, (previous, next) => {
        const threads = runBanners({ next, previous }).map(
          ({ threadId }) => threadId,
        );
        expect(new Set(threads).size).toBe(threads.length);
      }),
    );
  });

  test("a thread present in both snapshots with the same state never produces one", () => {
    assertProperty(
      "a thread present in both snapshots with the same state never produces one",
      fc.property(snapshot, snapshot, (previous, next) => {
        const before = shownState(previous);
        const after = shownState(next);
        const unchanged = [...after].flatMap(([threadId, state]) =>
          before.get(threadId) === state ? [threadId] : [],
        );
        // The fixture must reach the case, or the property says nothing.
        fc.pre(unchanged.length > 0);
        const bannered = new Set(
          runBanners({ next, previous }).map(({ threadId }) => threadId),
        );
        for (const threadId of unchanged) {
          expect(bannered.has(threadId)).toBe(false);
        }
      }),
    );
  });
});

describe("the banners still to show", () => {
  test("newer news replaces older news for the same chat", () => {
    const queue = queueRunBanners({
      previous: [run("a", CHAT_ACTIVE_RUN_STATE.working)],
      next: [run("a", CHAT_ACTIVE_RUN_STATE.needsYou)],
      queue: [],
    });
    expect(
      shape(
        queueRunBanners({
          previous: [run("a", CHAT_ACTIVE_RUN_STATE.needsYou)],
          next: [],
          queue,
        }),
      ),
    ).toEqual([["a", RUN_BANNER_TYPE.finished]]);
  });

  test("a chat answered elsewhere no longer waits in the queue", () => {
    const queue = queueRunBanners({
      previous: [run("a", CHAT_ACTIVE_RUN_STATE.working)],
      next: [run("a", CHAT_ACTIVE_RUN_STATE.needsYou)],
      queue: [],
    });
    expect(
      queueRunBanners({
        previous: [run("a", CHAT_ACTIVE_RUN_STATE.needsYou)],
        next: [run("a", CHAT_ACTIVE_RUN_STATE.working)],
        queue,
      }),
    ).toEqual([]);
  });

  test("holds at most one banner per chat, and only true waits", () => {
    assertProperty(
      "holds at most one banner per chat, and only true waits",
      fc.property(fc.array(snapshot, { maxLength: 6 }), (reads) => {
        let previous: readonly ActiveChatRun[] | undefined;
        let queue: ReturnType<typeof queueRunBanners> = [];
        for (const next of reads) {
          queue = queueRunBanners({ next, previous, queue });
          previous = next;
          const threads = queue.map(({ threadId }) => threadId);
          expect(new Set(threads).size).toBe(threads.length);
          const shown = shownState(next);
          for (const { threadId, type } of queue) {
            if (type === RUN_BANNER_TYPE.needsYou) {
              expect(shown.get(threadId)).toBe(CHAT_ACTIVE_RUN_STATE.needsYou);
            }
          }
        }
      }),
    );
  });
});
