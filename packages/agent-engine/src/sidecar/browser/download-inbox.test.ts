import { describe, expect, test } from "bun:test";

import type { BrowserDownload } from "@stll/api-contract/browser-control";
import { waitFor } from "@stll/test-kit";

import {
  createDownloadInbox,
  DOWNLOAD_SETTLE_WAIT_MS,
  MAX_DOWNLOAD_WAIT_MS,
} from "./download-inbox";
import type { ReceivedDownload } from "./downloads";

const PDF_ADDRESS = "https://fixture-library.test/decisions/42/file";
const ANNEX_ADDRESS = "https://fixture-library.test/decisions/42/annex";
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
  pageUrl: null,
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

const inboxWith = (
  clock: ReturnType<typeof manualClock>["clock"],
  pageOf: (threadId: string) => string | null = () => null,
) =>
  createDownloadInbox({
    clock,
    home: "/unused-home",
    pageOf,
    runOf: (threadId) => (threadId === RUN.threadId ? RUN : null),
  });

const NOT_STOPPED = new AbortController().signal;

const settled = (
  deliveryId: string,
  sourceUrl = PDF_ADDRESS,
  shownDocument: string | null = null,
) =>
  ({
    controllerId: RUN.threadId,
    deliveryId,
    download: stopped(sourceUrl),
    shownDocument,
    type: "settled",
  }) as const;

const started = (
  deliveryId: string,
  controllerId = RUN.threadId,
  shownDocument: string | null = null,
) => ({ controllerId, deliveryId, shownDocument, type: "started" }) as const;

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
      shownSaving: false,
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
    expect(await taking).toEqual({
      downloads: [],
      saving: 1,
      shown: null,
      shownSaving: false,
    });

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
    ).toEqual({ downloads: [], saving: 0, shown: null, shownSaving: false });
    expect(time.pending()).toEqual([]);
  });
});

describe("a document the tab shows", () => {
  /** Where the save's fetch ended: on the shown site, but not the shown address. */
  const FETCHED = "https://fixture-library.test/files/42.pdf";

  test("its save is matched by the shown document, and repeated on every later read of the run", async () => {
    const inbox = inboxWith(manualClock().clock);
    inbox.arrive(settled("d-1", FETCHED, PDF_ADDRESS));
    // A page's own download of the same address is no save of the document.
    inbox.arrive(settled("d-2", PDF_ADDRESS));

    const first = await inbox.take(RUN, {
      shownAddress: `${PDF_ADDRESS}#page=3`,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    const outcome = {
      ...REFUSED_INTERRUPTED,
      pageUrl: PDF_ADDRESS,
      sourceUrl: FETCHED,
    };
    expect(first.shown).toEqual(outcome);
    // The same entry as in the list, so a result can leave it out there.
    expect(first.downloads.some((entry) => entry === first.shown)).toBe(true);
    expect(first.downloads).toHaveLength(2);

    const again = await inbox.take(RUN, {
      shownAddress: PDF_ADDRESS,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(again).toEqual({
      downloads: [],
      saving: 0,
      shown: outcome,
      shownSaving: false,
    });

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

  /** An inbox whose file move a test stands in for: a saved report is saved. */
  const movingInbox = () =>
    createDownloadInbox({
      clock: manualClock().clock,
      home: "/unused-home",
      pageOf: () => null,
      receive: async (download) =>
        download.outcome === "saved"
          ? {
              bytes: download.bytes,
              duplicate: false,
              path: "Downloads/Judgment 42.pdf",
              sha256: "0".repeat(64),
              sourceUrl: download.sourceUrl,
              status: "saved",
            }
          : {
              message: "Too many downloads ran at once.",
              reason: "too_many",
              sourceUrl: download.sourceUrl,
              status: "refused",
            },
      runOf: () => RUN,
    });

  const savedReport = (deliveryId: string) =>
    ({
      controllerId: RUN.threadId,
      deliveryId,
      download: {
        bytes: 4096,
        mime: "application/pdf",
        outcome: "saved",
        path: "/staging/file.pdf",
        sourceUrl: FETCHED,
        suggestedName: "Judgment 42",
      },
      shownDocument: PDF_ADDRESS,
      type: "settled",
    }) as const;

  const tooMany = (deliveryId: string) =>
    ({
      ...settled(deliveryId, PDF_ADDRESS, PDF_ADDRESS),
      download: {
        outcome: "stopped",
        reason: "too-many",
        sourceUrl: PDF_ADDRESS,
        suggestedName: "Judgment 42",
      },
    }) as const;

  const readShown = async (inbox: ReturnType<typeof movingInbox>) =>
    (
      await inbox.take(RUN, {
        shownAddress: PDF_ADDRESS,
        signal: NOT_STOPPED,
        since: inbox.mark(),
      })
    ).shown;

  test("only the shown document's own save in progress counts as it saving", async () => {
    const inbox = inboxWith(manualClock().clock);
    // A page's download and another PDF's save are still running.
    inbox.arrive(started("d-1"));
    inbox.arrive(started("d-2", RUN.threadId, `${PDF_ADDRESS}/annex`));
    const take = async () =>
      await inbox.take(RUN, {
        shownAddress: `${PDF_ADDRESS}#page=2`,
        signal: NOT_STOPPED,
        since: inbox.mark(),
      });

    expect(await take()).toMatchObject({ saving: 2, shownSaving: false });

    inbox.arrive(started("d-3", RUN.threadId, PDF_ADDRESS));
    expect(await take()).toMatchObject({ saving: 3, shownSaving: true });

    inbox.arrive(settled("d-3", PDF_ADDRESS, PDF_ADDRESS));
    expect(await take()).toMatchObject({ saving: 2, shownSaving: false });
  });

  test("a refusal after the document was saved never replaces its saved copy", async () => {
    const inbox = movingInbox();
    inbox.arrive(savedReport("d-1"));
    expect(await readShown(inbox)).toMatchObject({ status: "saved" });

    inbox.arrive(tooMany("d-2"));
    expect(await readShown(inbox)).toMatchObject({
      path: "Downloads/Judgment 42.pdf",
      status: "saved",
    });

    // Also when both arrive before one read.
    const together = movingInbox();
    together.arrive(savedReport("d-1"));
    together.arrive(tooMany("d-2"));
    expect(await readShown(together)).toMatchObject({ status: "saved" });
  });

  test("a save after a refusal for the limit replaces the refusal", async () => {
    const inbox = movingInbox();
    inbox.arrive(tooMany("d-1"));
    expect(await readShown(inbox)).toMatchObject({
      reason: "too_many",
      status: "refused",
    });

    inbox.arrive(savedReport("d-2"));
    expect(await readShown(inbox)).toMatchObject({ status: "saved" });
  });
});

describe("downloads and the runs of a chat", () => {
  const RUN_2 = { ...RUN, runId: "run-2", workspaceDir: "/unused-run-2" };
  const ANNEX = "https://fixture-library.test/decisions/42/annex";

  /** An inbox whose held run is `held.run`; each save is judged by `onSave`. */
  const runsInbox = () => {
    const held: { run: typeof RUN | null } = { run: RUN };
    const hooks = { onSave: (_sourceUrl: string): void => undefined };
    const inbox = createDownloadInbox({
      clock: manualClock().clock,
      home: "/unused-home",
      pageOf: () => null,
      receive: async (download, { workspaceDir }) => {
        hooks.onSave(download.sourceUrl);
        return await Promise.resolve({
          bytes: 10,
          duplicate: false,
          path: `${workspaceDir}/Downloads/file.pdf`,
          sha256: "0".repeat(64),
          sourceUrl: download.sourceUrl,
          status: "saved" as const,
        });
      },
      runOf: () => held.run,
    });
    return { held, hooks, inbox };
  };

  const take = async (
    inbox: ReturnType<typeof runsInbox>["inbox"],
    run: typeof RUN,
  ) =>
    await inbox.take(run, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });

  test("a download saved for one run is handed only to that run, and goes with it", async () => {
    const { inbox } = runsInbox();
    inbox.arrive(settled("d-1"));

    // A later run of the chat asks first: run 1's file is not in its folder.
    expect((await take(inbox, RUN_2)).downloads).toEqual([]);
    expect((await take(inbox, RUN)).downloads).toEqual([
      expect.objectContaining({
        path: "/unused-run-folder/Downloads/file.pdf",
      }),
    ]);

    // Saved for run 1, which then ends: it goes with that run.
    inbox.arrive(settled("d-2"));
    inbox.forgetRun(RUN.runId);
    expect((await take(inbox, RUN)).downloads).toEqual([]);
    expect((await take(inbox, RUN_2)).downloads).toEqual([]);
  });

  test("a download that arrived between runs is saved into the run that takes it", async () => {
    const { held, inbox } = runsInbox();
    held.run = null;
    inbox.arrive(settled("d-1"));

    expect((await take(inbox, RUN_2)).downloads).toEqual([
      expect.objectContaining({ path: "/unused-run-2/Downloads/file.pdf" }),
    ]);
  });

  test("a download that settles while a result waits for another is counted as saving, then listed", async () => {
    const { held, hooks, inbox } = runsInbox();
    // A arrives between runs, so the result saves it while it is taken.
    held.run = null;
    inbox.arrive(settled("d-a", PDF_ADDRESS));
    held.run = RUN;
    inbox.arrive(started("d-b", RUN.threadId, ANNEX));
    // B settles exactly while the result waits for A's save.
    hooks.onSave = (sourceUrl) => {
      if (sourceUrl === PDF_ADDRESS) {
        inbox.arrive(settled("d-b", ANNEX, ANNEX));
      }
    };

    const first = await inbox.take(RUN, {
      shownAddress: ANNEX,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(first.downloads.map(({ sourceUrl }) => sourceUrl)).toEqual([
      PDF_ADDRESS,
    ]);
    expect(first).toMatchObject({ saving: 1, shownSaving: true });

    const next = await take(inbox, RUN);
    expect(next.downloads.map(({ sourceUrl }) => sourceUrl)).toEqual([ANNEX]);
    expect(next).toMatchObject({ saving: 0, shownSaving: false });
  });

  test("a start announced for one run is not counted as saving by another", async () => {
    const { inbox } = runsInbox();
    inbox.arrive(started("d-1", RUN.threadId, PDF_ADDRESS));

    expect(await take(inbox, RUN_2)).toMatchObject({ saving: 0 });
    expect(await take(inbox, RUN)).toMatchObject({ saving: 1 });
    inbox.forgetRun(RUN.runId);
    expect(await take(inbox, RUN)).toMatchObject({ saving: 0 });
  });
});

describe("where a download came from", () => {
  const SEARCH_PAGE = "https://fixture-library.test/search?q=notice";
  const DECISION_PAGE = "https://fixture-library.test/decisions/42";

  test("a page's download comes from the page the chat was on as it started", async () => {
    const page = { current: DECISION_PAGE };
    const inbox = inboxWith(manualClock().clock, () => page.current);
    inbox.arrive(started("d-1"));
    // The click that started it moved the chat on before it settled.
    page.current = SEARCH_PAGE;
    inbox.arrive(settled("d-1"));

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.downloads).toEqual([
      {
        ...REFUSED_INTERRUPTED,
        pageUrl: DECISION_PAGE,
        sourceUrl: PDF_ADDRESS,
      },
    ]);
  });

  test("one started before the chat read any page keeps no page, whatever the chat reads before it settles", async () => {
    const page: { current: string | null } = { current: null };
    const inbox = inboxWith(manualClock().clock, () => page.current);
    inbox.arrive(started("d-1"));
    page.current = DECISION_PAGE;
    inbox.arrive(settled("d-1"));

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.downloads).toMatchObject([{ pageUrl: null }]);
  });

  test("a file from another site than the page the chat read has no page", async () => {
    const inbox = inboxWith(manualClock().clock, () => DECISION_PAGE);
    for (const [deliveryId, sourceUrl] of [
      ["d-1", "https://other-site.test/file.pdf"],
      ["d-2", "blob:https://other-site.test/1c9e0f1e"],
      ["d-3", "data:application/pdf;base64,JVBERi0="],
    ] as const) {
      inbox.arrive(started(deliveryId));
      inbox.arrive(settled(deliveryId, sourceUrl));
    }

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.downloads.map(({ pageUrl }) => pageUrl)).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("one stopped before it started comes from the page the chat is on at its report", async () => {
    const inbox = inboxWith(manualClock().clock, () => SEARCH_PAGE);
    inbox.arrive(settled("d-1"));

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.downloads).toMatchObject([{ pageUrl: SEARCH_PAGE }]);
  });

  test("a shown PDF's save comes from the PDF itself, whatever page the chat read", async () => {
    const inbox = inboxWith(manualClock().clock, () => SEARCH_PAGE);
    inbox.arrive(started("d-1", RUN.threadId, `${PDF_ADDRESS}#page=2`));
    inbox.arrive(settled("d-1", PDF_ADDRESS, PDF_ADDRESS));

    const taken = await inbox.take(RUN, {
      shownAddress: PDF_ADDRESS,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.shown).toMatchObject({ pageUrl: PDF_ADDRESS });
  });

  test("a saved one carries when it arrived", async () => {
    const time = manualClock();
    const inbox = createDownloadInbox({
      clock: time.clock,
      home: "/unused-home",
      pageOf: () => DECISION_PAGE,
      receive: async (download) =>
        await Promise.resolve({
          bytes: 10,
          duplicate: false,
          path: "Downloads/Judgment 42.pdf",
          sha256: "a".repeat(64),
          sourceUrl: download.sourceUrl,
          status: "saved" as const,
        }),
      runOf: () => RUN,
    });
    time.state.time = Date.UTC(2026, 10, 25, 9, 30);
    inbox.arrive(settled("d-1"));

    const taken = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(taken.downloads).toEqual([
      {
        bytes: 10,
        downloadedAt: "2026-11-25T09:30:00Z",
        duplicate: false,
        pageUrl: DECISION_PAGE,
        path: "Downloads/Judgment 42.pdf",
        sha256: "a".repeat(64),
        sourceUrl: PDF_ADDRESS,
        status: "saved",
      },
    ]);
  });
});

describe("filing a saved download with stella", () => {
  test("a saved one is filed with where it came from, and a refused one is not", async () => {
    const filings: unknown[] = [];
    const run = {
      ...RUN,
      fileDownload: async (download: unknown) => {
        filings.push(download);
        return await Promise.resolve({
          documentId: "doc-1",
          duplicate: false,
          matterId: "matter-1",
          name: "Judgment 42.pdf",
          status: "document" as const,
        });
      },
    };
    const time = manualClock();
    time.state.time = Date.UTC(2026, 10, 25, 9, 30);
    const inbox = createDownloadInbox({
      clock: time.clock,
      home: "/unused-home",
      pageOf: () => "https://fixture-library.test/decisions/42",
      receive: async (download) =>
        download.suggestedName === "saved"
          ? {
              bytes: 10,
              duplicate: false,
              path: "Downloads/Judgment 42.pdf",
              sha256: "a".repeat(64),
              sourceUrl: download.sourceUrl,
              status: "saved" as const,
            }
          : {
              message: "Chrome could not finish the download.",
              reason: "interrupted" as const,
              sourceUrl: download.sourceUrl,
              status: "refused" as const,
            },
      runOf: () => run,
    });
    inbox.arrive({
      ...settled("d-1"),
      download: { ...stopped(PDF_ADDRESS), suggestedName: "saved" },
    });
    inbox.arrive(settled("d-2"));

    const taken = await inbox.take(run, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });

    expect(taken.downloads).toMatchObject([
      {
        filed: { documentId: "doc-1", status: "document" },
        status: "saved",
      },
      { status: "refused" },
    ]);
    expect(taken.downloads.at(1)).not.toHaveProperty("filed");
    expect(filings).toEqual([
      {
        origin: {
          downloadedAt: "2026-11-25T09:30:00Z",
          pageUrl: "https://fixture-library.test/decisions/42",
          sourceUrl: PDF_ADDRESS,
        },
        path: "Downloads/Judgment 42.pdf",
        sha256: "a".repeat(64),
      },
    ]);
  });

  test("a download a Plan run's step started is never filed, even when a later run saves it", async () => {
    const filings: unknown[] = [];
    const fileDownload = async (download: unknown) => {
      filings.push(download);
      return await Promise.resolve({
        documentId: "doc-1",
        duplicate: false,
        matterId: "matter-1",
        name: "Judgment 42.pdf",
        status: "document" as const,
      });
    };
    const planRun = { ...RUN, approvals: "plan" as const, fileDownload };
    const autoRun = {
      ...RUN,
      approvals: "auto" as const,
      fileDownload,
      runId: "run-2",
    };
    const held: { run: typeof planRun | typeof autoRun } = { run: planRun };
    const inbox = createDownloadInbox({
      clock: manualClock().clock,
      home: "/unused-home",
      pageOf: () => null,
      receive: async (download) =>
        await Promise.resolve({
          bytes: 10,
          duplicate: false,
          path: "Downloads/Judgment 42.pdf",
          sha256: "a".repeat(64),
          sourceUrl: download.sourceUrl,
          status: "saved" as const,
        }),
      runOf: () => held.run,
    });
    inbox.arrive(started("d-plan"));
    // The Plan run ends while Chrome is still saving; a later run is held
    // when the download settles.
    inbox.forgetRun(planRun.runId);
    held.run = autoRun;
    inbox.arrive({
      ...settled("d-plan"),
      download: { ...stopped(PDF_ADDRESS), suggestedName: "saved" },
    });
    inbox.arrive(started("d-auto"));
    inbox.arrive({
      ...settled("d-auto"),
      download: { ...stopped(ANNEX_ADDRESS), suggestedName: "saved" },
    });

    const taken = await inbox.take(autoRun, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });

    expect(taken.downloads).toMatchObject([
      {
        filed: {
          message:
            "In Plan mode stella files nothing into the matter. The file is in your working folder only.",
          status: "not_filed",
        },
        sourceUrl: PDF_ADDRESS,
      },
      { filed: { status: "document" }, sourceUrl: ANNEX_ADDRESS },
    ]);
    expect(filings).toMatchObject([{ origin: { sourceUrl: ANNEX_ADDRESS } }]);
  });
});

describe("a result's bound covers the save as well", () => {
  /** An inbox whose saves finish only when the test says so. */
  const slowInbox = (time: ReturnType<typeof manualClock>) => {
    const saves: PromiseWithResolvers<ReceivedDownload>[] = [];
    const inbox = createDownloadInbox({
      clock: time.clock,
      home: "/unused-home",
      pageOf: () => null,
      receive: async () => {
        const save = Promise.withResolvers<ReceivedDownload>();
        saves.push(save);
        return await save.promise;
      },
      runOf: () => RUN,
    });
    return { inbox, saves };
  };

  const SAVED: ReceivedDownload = {
    bytes: 10,
    duplicate: false,
    path: "Downloads/Judgment 42.pdf",
    sha256: "a".repeat(64),
    sourceUrl: PDF_ADDRESS,
    status: "saved",
  };

  test("a save still running when the bound runs out is counted as saving, then listed by a later result", async () => {
    const time = manualClock();
    const { inbox, saves } = slowInbox(time);
    inbox.arrive(settled("d-1"));

    const first = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    // The save gets the result's bound, and no more.
    expect(
      await waitFor(
        () => (time.pending().length > 0 ? time.pending() : undefined),
        { description: "the result to wait for the save" },
      ),
    ).toEqual([DOWNLOAD_SETTLE_WAIT_MS]);
    time.runOut();
    expect(await first).toMatchObject({ downloads: [], saving: 1 });

    saves.at(0)?.resolve(SAVED);
    const later = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: inbox.mark(),
    });
    expect(later).toMatchObject({
      downloads: [{ path: SAVED.path, status: "saved" }],
      saving: 0,
    });
  });

  test("a wait that is stopped returns at once, and the save stays held", async () => {
    const time = manualClock();
    const { inbox } = slowInbox(time);
    inbox.arrive(settled("d-1"));
    const stop = new AbortController();

    const taking = inbox.take(RUN, {
      shownAddress: null,
      signal: stop.signal,
      since: 0,
      waitMs: MAX_DOWNLOAD_WAIT_MS,
    });
    stop.abort();

    expect(await taking).toMatchObject({ downloads: [], saving: 1 });
    expect(time.pending()).toEqual([]);
  });
});

describe("waiting for downloads after the step returned", () => {
  test("a download still saving after its step's result is waited for and handed out once it settles", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    const since = inbox.mark();
    inbox.arrive(started("d-1"));

    // The click's own result gives up after the settle wait.
    const step = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since,
    });
    time.runOut();
    expect(await step).toMatchObject({ downloads: [], saving: 1 });

    // A later wait counts every download still saving, whenever it began.
    const waiting = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: 0,
      waitMs: MAX_DOWNLOAD_WAIT_MS,
    });
    expect(time.pending()).toEqual([MAX_DOWNLOAD_WAIT_MS]);
    inbox.arrive(settled("d-1"));

    expect(await waiting).toEqual({
      downloads: [{ ...REFUSED_INTERRUPTED, sourceUrl: PDF_ADDRESS }],
      saving: 0,
      shown: null,
      shownSaving: false,
    });
    expect(time.pending()).toEqual([]);
  });

  test("a wait that runs out says how many are still saving", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    inbox.arrive(started("d-1"));
    inbox.arrive(started("d-2"));

    const waiting = inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: 0,
      waitMs: 5000,
    });
    inbox.arrive(settled("d-1"));
    // One settled; the wait goes on for the other.
    expect(time.pending()).toEqual([5000]);
    time.runOut();

    expect(await waiting).toMatchObject({
      downloads: [{ status: "refused" }],
      saving: 1,
    });
  });

  test("another chat's downloads are never waited for", async () => {
    const time = manualClock();
    const inbox = inboxWith(time.clock);
    inbox.arrive(started("d-1", "thread-2"));

    const waited = await inbox.take(RUN, {
      shownAddress: null,
      signal: NOT_STOPPED,
      since: 0,
      waitMs: MAX_DOWNLOAD_WAIT_MS,
    });
    expect(waited).toMatchObject({ downloads: [], saving: 0 });
    expect(time.pending()).toEqual([]);
  });
});
