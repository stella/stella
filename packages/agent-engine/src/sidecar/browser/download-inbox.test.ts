import { describe, expect, test } from "bun:test";

import type { BrowserDownload } from "@stll/api-contract/browser-control";

import { createDownloadInbox, DOWNLOAD_SETTLE_WAIT_MS } from "./download-inbox";

const PDF_ADDRESS = "https://fixture-library.test/decisions/42/file";
const RUN = {
  runId: "run-1",
  threadId: "thread-1",
  workspaceDir: "/unused-run-folder",
};

/** A save the extension stopped: judged here without touching any file. */
const stopped = (sourceUrl: string): BrowserDownload => ({
  outcome: "stopped",
  reason: "interrupted",
  sourceUrl,
  suggestedName: "Judgment 42",
});

const REFUSED_INTERRUPTED = {
  message: "Chrome could not finish the download.",
  reason: "interrupted",
  status: "refused",
} as const;

/** A clock whose time and timers move only when the test says so. */
const manualClock = () => {
  const state = { time: 0 };
  const timers = new Map<() => void, number>();
  return {
    clock: {
      now: () => state.time,
      schedule: (task: () => void, ms: number) => {
        timers.set(task, ms);
        return () => {
          timers.delete(task);
        };
      },
    },
    /** The delays of the timers set and not yet run or cancelled. */
    pending: () => [...timers.values()],
    /** Every pending timer runs out. */
    runOut: () => {
      const due = [...timers.keys()];
      timers.clear();
      for (const task of due) {
        task();
      }
    },
    state,
  };
};

const inboxWith = (clock: ReturnType<typeof manualClock>["clock"]) =>
  createDownloadInbox({
    clock,
    home: "/unused-home",
    runOf: (threadId) => (threadId === RUN.threadId ? RUN : null),
  });

const NOT_STOPPED = new AbortController().signal;

const settled = (deliveryId: string, sourceUrl = PDF_ADDRESS) =>
  ({
    controllerId: RUN.threadId,
    deliveryId,
    download: stopped(sourceUrl),
    type: "settled",
  }) as const;

const started = (deliveryId: string, controllerId = RUN.threadId) =>
  ({ controllerId, deliveryId, type: "started" }) as const;

describe("a browser step's downloads", () => {
  test("a step waits for the downloads it started and its result carries them", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    const since = inbox.mark();
    inbox.arrive(started("d-1"));

    const taking = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since,
    });
    // Waiting, for at most the settle wait.
    expect(time.pending()).toEqual([DOWNLOAD_SETTLE_WAIT_MS]);
    inbox.arrive(settled("d-1"));

    expect(await taking).toEqual({
      downloads: [{ ...REFUSED_INTERRUPTED, sourceUrl: PDF_ADDRESS }],
      saving: 0,
      shown: null,
    });
    // It ended when the download settled, and its timer with it.
    expect(time.pending()).toEqual([]);
  });

  test("one still saving after the wait is counted, then listed by a later result", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    const since = inbox.mark();
    inbox.arrive(started("d-1"));

    const taking = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since,
    });
    time.runOut();
    expect(await taking).toEqual({ downloads: [], saving: 1, shown: null });

    inbox.arrive(settled("d-1"));
    const later = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(later.downloads).toHaveLength(1);
    expect(later.saving).toBe(0);
  });

  test("a download started before the step never holds it", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    inbox.arrive(started("d-0"));

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });

    expect(taken.saving).toBe(1);
    expect(time.pending()).toEqual([]);
  });

  test("the call ending ends the wait", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    const since = inbox.mark();
    inbox.arrive(started("d-1"));
    const stop = new AbortController();

    const taking = inbox.take(RUN, {
      shownAddress: null,
      signal: stop.signal,
      since,
    });
    stop.abort();

    expect((await taking).saving).toBe(1);
    expect(time.pending()).toEqual([]);
  });

  test("a start whose report never came stops counting after a while", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    inbox.arrive(started("d-1"));
    time.state.time = 11 * 60_000;

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });

    expect(taken.saving).toBe(0);
  });

  test("another chat's downloads never reach this one", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    const since = inbox.mark();
    inbox.arrive(started("d-9", "thread-2"));
    inbox.arrive({ ...settled("d-9"), controllerId: "thread-2" });

    expect(
      await inbox.take(RUN, { shownAddress: null, signal: NOT_STOPPED, since }),
    ).toEqual({ downloads: [], saving: 0, shown: null });
    expect(time.pending()).toEqual([]);
  });
});

describe("a document the tab shows", () => {
  test("its save is named by its address, and repeated on every later read of the run", async () => {
    const inbox = inboxWith(manualClock().clock);
    inbox.arrive(settled("d-1"));
    inbox.arrive(settled("d-2", "https://fixture-library.test/annex"));

    const first = await inbox.take(RUN, {
      shownAddress: `${PDF_ADDRESS}#page=3`,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    const outcome = { ...REFUSED_INTERRUPTED, sourceUrl: PDF_ADDRESS };
    expect(first.shown).toEqual(outcome);
    // The same entry as in the list, so a result can leave it out there.
    expect(first.downloads.some((entry) => entry === first.shown)).toBe(true);

    const again = await inbox.take(RUN, {
      shownAddress: PDF_ADDRESS,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(again).toEqual({ downloads: [], saving: 0, shown: outcome });

    // Another run of the chat saves its own copy; until then none is known.
    const otherRun = await inbox.take(
      { ...RUN, runId: "run-2" },
      { shownAddress: PDF_ADDRESS, signal: NOT_STOPPED, since: inbox.mark() },
    );
    expect(otherRun.shown).toBeNull();

    inbox.forgetRun(RUN.runId);
    const forgotten = await inbox.take(RUN, {
      shownAddress: PDF_ADDRESS,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(forgotten.shown).toBeNull();
  });
});
