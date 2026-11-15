import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STAGED_NAME_PATTERN,
  BROWSER_DOWNLOAD_STAGING_FOLDER,
  type BrowserDownload,
} from "@stll/api-contract/browser-control";

import {
  DELIVERY_TIMEOUT_MS,
  desktopDownloadVerdict,
  holdDownloadForJudgement,
  loadDownloadScope,
  MAX_RUNNING_DELIVERIES,
  reportDeliveredDownload,
  saveShownPdf,
  setDeliveryTimer,
  setDownloadReporter,
  setDownloadScope,
  setShownPdfReader,
} from "./download-guard";
import type { ShownPdfRead } from "./shown-pdf-reader";

const NOW = 1_794_300_000_000;
const clock = { now: () => NOW };
const FILE_URL = "https://fixture-library.test/decisions/42/file";
const DOWNLOADS = "/Volumes/Work/Downloads";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  setDownloadReporter({ settled: () => undefined, started: () => undefined });
  setShownPdfReader({
    read: async () => ({ reason: "interrupted", type: "refused" }),
    release: async () => undefined,
  });
  setDeliveryTimer(() => () => undefined);
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

type Holder =
  | { type: "web" }
  | { type: "desktop"; chatId: string; link: "connected" | "offline" };

/** Chrome never reuses a download id; the guard keeps its judgements by id. */
let lastDownloadId = 5000;

/** The extension's own `blob:` addresses never repeat either. */
let lastBlob = 0;

/**
 * Tab 3 is chat's, on the fixture library; tab 1 is the member's. Tab 3
 * navigated to `FILE_URL` a second ago, so a download of it traces to tab 3.
 * `holder` is who holds the browser, as the control record stores it. The
 * offscreen reader keeps whatever it reads as a fresh `blob:` address,
 * unless a test sets `reader.answer`.
 */
const installFakeChrome = (holder: Holder) => {
  const events: string[] = [];
  const items = new Map<number, chrome.downloads.DownloadItem>();
  /** The ids Chrome gave the extension's own downloads, in order. */
  const startedIds: number[] = [];
  // What Chrome does when the extension asks it to download: by default it
  // answers with a new download id.
  const chromeDownloads = {
    /** Called when the guard asks Chrome to stop a download. */
    onCancel: (): void => undefined,
    start: async (
      _options: chrome.downloads.DownloadOptions,
    ): Promise<number> => {
      lastDownloadId += 1;
      startedIds.push(lastDownloadId);
      return lastDownloadId;
    },
  };
  const session: Record<string, unknown> = {
    browserContainedTabs: {
      controlledTabId: 3,
      openedTabIds: [],
      userTabIds: [1],
    },
    browserRecentNavigations: [{ at: NOW - 1000, tabId: 3, url: FILE_URL }],
    ...(holder.type === "desktop"
      ? {
          browserControlOwner: `desktop:${holder.chatId}`,
          browserDesktopLink: holder.link,
        }
      : {}),
  };
  setDownloadScope({ contained: [3], user: [1] });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      action: {
        setBadgeText: async ({ text }: { text: string }) => {
          events.push(`badge:${text}`);
        },
        setTitle: async () => undefined,
      },
      downloads: {
        download: async (options: chrome.downloads.DownloadOptions) => {
          events.push(`download:${options.url}`);
          return await chromeDownloads.start(options);
        },
        cancel: async (id: number) => {
          events.push(`cancel:${id}`);
          chromeDownloads.onCancel();
          // Chrome stops only a download still running.
          const item = items.get(id);
          if (item !== undefined && item.state !== "complete") {
            items.set(id, { ...item, state: "interrupted" });
          }
        },
        removeFile: async (id: number) => {
          events.push(`remove:${id}`);
        },
        search: async ({ id }: { id: number }) => {
          const item = items.get(id);
          return item === undefined ? [] : [item];
        },
      },
      i18n: { getMessage: (name: string) => name },
      runtime: { id: "stella-extension" },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          set: async (values: Record<string, unknown>) => {
            Object.assign(session, values);
          },
        },
      },
      tabs: { query: async () => [{ id: 1 }, { id: 3 }] },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => [
          {
            frameId: 0,
            url:
              tabId === 3
                ? "https://fixture-library.test/decisions/42"
                : "https://files.example.org/",
          },
        ],
      },
    },
  });
  const reports: { chatId: string; download: BrowserDownload }[] = [];
  /** Each report's delivery id and shown document, started or settled, in order. */
  const deliveries: {
    deliveryId: string;
    report: "settled" | "started";
    shownDocument: string | null;
  }[] = [];
  /** Each settled report's shown document, in order. */
  const shownDocuments: (string | null)[] = [];
  setDownloadReporter({
    settled: ({ chatId, deliveryId, download, shownDocument }) => {
      reports.push({ chatId, download });
      deliveries.push({ deliveryId, report: "settled", shownDocument });
      shownDocuments.push(shownDocument);
    },
    started: (_chatId, deliveryId, shownDocument) => {
      deliveries.push({ deliveryId, report: "started", shownDocument });
    },
  });
  const reader = {
    answer: (url: string): ShownPdfRead => {
      lastBlob += 1;
      return {
        bytes: 2048,
        downloadUrl: `blob:chrome-extension://stella-extension/${String(lastBlob)}`,
        fetchedUrl: url,
        type: "read",
      };
    },
    /** Each address a read kept, in order. */
    blobUrls: new Array<string>(),
    reads: new Array<{ maxBytes: number; url: string }>(),
    releases: new Array<string>(),
  };
  /** Each delivery deadline set and not yet ended. */
  const deliveryTimers: { ms: number; task: () => void }[] = [];
  setDeliveryTimer((task, ms) => {
    const timer = { ms, task };
    deliveryTimers.push(timer);
    return () => {
      const index = deliveryTimers.indexOf(timer);
      if (index !== -1) {
        deliveryTimers.splice(index, 1);
      }
    };
  });
  setShownPdfReader({
    read: async (url, maxBytes) => {
      reader.reads.push({ maxBytes, url });
      const answer = reader.answer(url);
      if (answer.type === "read") {
        reader.blobUrls.push(answer.downloadUrl);
      }
      return answer;
    },
    release: async (downloadUrl) => {
      reader.releases.push(downloadUrl);
    },
  });
  return {
    chromeDownloads,
    deliveries,
    deliveryTimers,
    events,
    items,
    reader,
    reports,
    shownDocuments,
    startedIds,
  };
};

/** A download of `FILE_URL` as Chrome reports it while naming the file. */
const fileDownload = (
  id: number,
  { filename, mime }: { filename: string; mime: string },
): chrome.downloads.DownloadItem => ({
  bytesReceived: 0,
  canResume: false,
  danger: "safe",
  exists: true,
  fileSize: 0,
  filename,
  finalUrl: FILE_URL,
  id,
  incognito: false,
  mime,
  paused: false,
  referrer: "",
  startTime: "2026-11-14T00:00:00.000Z",
  state: "in_progress",
  totalBytes: 2048,
  url: FILE_URL,
});

/** Holds the download for its judgement and answers what Chrome was told. */
const named = async (
  download: chrome.downloads.DownloadItem,
): Promise<chrome.downloads.FilenameSuggestion | undefined> =>
  await new Promise((resolve) => {
    holdDownloadForJudgement(
      download,
      (suggestion) => {
        resolve(suggestion);
      },
      clock,
    );
  });

describe("a download from chat's tab", () => {
  test("a desktop chat takes a PDF: Chrome saves it in the staging folder and the chat hears where", async () => {
    const { deliveries, events, items, reports } = installFakeChrome({
      chatId: "thread-7",
      link: "connected",
      type: "desktop",
    });
    await loadDownloadScope();
    const download = fileDownload(901, {
      filename: "Judgment 42.pdf",
      mime: "application/pdf",
    });
    items.set(download.id, download);

    const suggestion = await named(download);
    expect(events).toEqual([]);
    expect(suggestion?.conflictAction).toBe("uniquify");
    const [folder, name, ...rest] = (suggestion?.filename ?? "").split("/");
    expect(folder).toBe(BROWSER_DOWNLOAD_STAGING_FOLDER);
    expect(BROWSER_DOWNLOAD_STAGED_NAME_PATTERN.test(name ?? "")).toBe(true);
    expect(rest).toEqual([]);

    const savedAt = `${DOWNLOADS}/${suggestion?.filename ?? ""}`;
    items.set(download.id, {
      ...download,
      bytesReceived: 2048,
      fileSize: 2048,
      filename: savedAt,
      state: "complete",
    });
    await reportDeliveredDownload({
      id: download.id,
      state: { current: "complete", previous: "in_progress" },
    });
    // Settled once: a later change of the same download reports nothing.
    await reportDeliveredDownload({
      id: download.id,
      state: { current: "complete", previous: "in_progress" },
    });

    expect(reports).toEqual([
      {
        chatId: "thread-7",
        download: {
          bytes: 2048,
          mime: "application/pdf",
          outcome: "saved",
          path: savedAt,
          sourceUrl: FILE_URL,
          suggestedName: "Judgment 42.pdf",
        },
      },
    ]);
    // Announced when Chrome started it, under the id its report carries.
    expect(deliveries.map(({ report }) => report)).toEqual([
      "started",
      "settled",
    ]);
    expect(new Set(deliveries.map(({ deliveryId }) => deliveryId)).size).toBe(
      1,
    );
  });

  test("under the web connection the same PDF is stopped and nobody is told", async () => {
    const { events, items, reports } = installFakeChrome({ type: "web" });
    await loadDownloadScope();
    const download = fileDownload(902, {
      filename: "Judgment 42.pdf",
      mime: "application/pdf",
    });
    items.set(download.id, download);

    const suggestion = await named(download);

    expect(suggestion).toBeUndefined();
    expect(events).toEqual(["cancel:902", "badge:1"]);
    expect(reports).toEqual([]);
  });

  test("a desktop chat whose stella desktop is not connected gets nothing saved", async () => {
    const { events, items, reports } = installFakeChrome({
      chatId: "thread-7",
      link: "offline",
      type: "desktop",
    });
    await loadDownloadScope();
    const download = fileDownload(903, {
      filename: "Judgment 42.pdf",
      mime: "application/pdf",
    });
    items.set(download.id, download);

    expect(await named(download)).toBeUndefined();
    expect(events).toEqual(["cancel:903", "badge:1"]);
    expect(reports).toEqual([]);
  });

  test("a desktop chat's tab downloading anything but a PDF is stopped, and the chat hears why", async () => {
    const { events, items, reports } = installFakeChrome({
      chatId: "thread-7",
      link: "connected",
      type: "desktop",
    });
    await loadDownloadScope();
    const download = fileDownload(904, {
      filename: "setup.dmg",
      mime: "application/octet-stream",
    });
    items.set(download.id, download);

    expect(await named(download)).toBeUndefined();
    expect(events).toEqual(["cancel:904", "badge:1"]);
    expect(reports).toEqual([
      {
        chatId: "thread-7",
        download: {
          outcome: "stopped",
          reason: "not-pdf",
          sourceUrl: FILE_URL,
          suggestedName: "setup.dmg",
        },
      },
    ]);
  });

  test("PDFs started together never pass the running limit, and the rest hear why", async () => {
    const { events, items, reports } = installFakeChrome({
      chatId: "thread-7",
      link: "connected",
      type: "desktop",
    });
    await loadDownloadScope();
    const started = Array.from(
      { length: MAX_RUNNING_DELIVERIES + 2 },
      (_, index) =>
        fileDownload(920 + index, {
          filename: `Judgment ${String(index)}.pdf`,
          mime: "application/pdf",
        }),
    );
    for (const download of started) {
      items.set(download.id, download);
    }

    const suggestions = await Promise.all(started.map(named));

    expect(
      suggestions.filter((suggestion) => suggestion !== undefined),
    ).toHaveLength(MAX_RUNNING_DELIVERIES);
    expect(events.filter((event) => event.startsWith("cancel:"))).toHaveLength(
      2,
    );
    expect(reports.map(({ download }) => download)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "too-many" }),
      expect.objectContaining({ outcome: "stopped", reason: "too-many" }),
    ]);
    // Each settled one frees its slot for the next download.
    const delivered = started.filter(
      (_, index) => suggestions[index] !== undefined,
    );
    for (const download of delivered) {
      items.set(download.id, { ...download, state: "interrupted" });
      // await-in-loop: each settles in turn, as Chrome reports them.
      await reportDeliveredDownload({
        id: download.id,
        state: { current: "interrupted", previous: "in_progress" },
      });
    }
    const next = fileDownload(930, {
      filename: "Judgment 10.pdf",
      mime: "application/pdf",
    });
    items.set(next.id, next);
    expect(await named(next)).toMatchObject({ conflictAction: "uniquify" });
    // Settled, so the next test starts with no download running.
    items.set(next.id, { ...next, state: "interrupted" });
    await reportDeliveredDownload({
      id: next.id,
      state: { current: "interrupted", previous: "in_progress" },
    });
  });

  test("a PDF Chrome could not finish is reported as interrupted", async () => {
    const { items, reports } = installFakeChrome({
      chatId: "thread-7",
      link: "connected",
      type: "desktop",
    });
    await loadDownloadScope();
    const download = fileDownload(905, {
      filename: "Judgment 42.pdf",
      mime: "application/pdf",
    });
    items.set(download.id, download);
    await named(download);
    items.set(download.id, { ...download, state: "interrupted" });

    await reportDeliveredDownload({
      id: download.id,
      state: { current: "interrupted", previous: "in_progress" },
    });

    expect(reports.map(({ download: reported }) => reported)).toEqual([
      {
        outcome: "stopped",
        reason: "interrupted",
        sourceUrl: FILE_URL,
        suggestedName: "Judgment 42.pdf",
      },
    ]);
  });
});

describe("a PDF chat's tab shows", () => {
  const PDF_URL = "https://fixture-library.test/decisions/42/file";
  const DESKTOP_CHAT = {
    chatId: "thread-7",
    link: "connected",
    type: "desktop",
  } as const;
  const shownPdf = (overrides: { turnId?: string; url?: string } = {}) => ({
    controllerId: "desktop:thread-7",
    tabId: 3,
    title: "Judgment 42",
    turnId: overrides.turnId ?? "run-1",
    url: overrides.url ?? `${PDF_URL}#page=2`,
  });

  /** The download Chrome makes of the extension's `blob:` address. */
  const ownDownload = (
    id: number,
    url: string,
  ): chrome.downloads.DownloadItem => ({
    ...fileDownload(id, { filename: "file", mime: "application/pdf" }),
    byExtensionId: "stella-extension",
    finalUrl: url,
    url,
  });

  /** Chrome finishes download `id` where it was told to save it. */
  const finish = async (
    items: Map<number, chrome.downloads.DownloadItem>,
    id: number,
    filename: string,
  ) => {
    const item = items.get(id);
    if (item === undefined) {
      throw new TypeError(`No download ${String(id)}`);
    }
    items.set(id, {
      ...item,
      bytesReceived: 2048,
      fileSize: 2048,
      filename,
      state: "complete",
    });
    await reportDeliveredDownload({
      id,
      state: { current: "complete", previous: "in_progress" },
    });
  };

  /** Each save the reader read, as Chrome downloads it: id and blob address. */
  const savesOf = ({
    reader,
    startedIds,
  }: ReturnType<typeof installFakeChrome>) =>
    startedIds.map((id, index) => ({
      id,
      url: reader.blobUrls[index] ?? "",
    }));

  test("a desktop chat has it read once and Chrome saves the reader's bytes, like a download", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    const { deliveries, events, items, reader, reports, shownDocuments } = fake;
    const asked: chrome.downloads.DownloadOptions[] = [];
    fake.chromeDownloads.start = async (options) => {
      asked.push(options);
      lastDownloadId += 1;
      fake.startedIds.push(lastDownloadId);
      return lastDownloadId;
    };

    await saveShownPdf(shownPdf());

    // Read by its address without the fragment; Chrome is handed the
    // reader's own address, into the staging folder, never with a prompt.
    expect(reader.reads).toEqual([
      { maxBytes: BROWSER_CONTROL_LIMITS.downloadBytes, url: PDF_URL },
    ]);
    expect(events).toEqual([`download:${reader.blobUrls[0] ?? ""}`]);
    expect(asked).toEqual([
      expect.objectContaining({ saveAs: false, url: reader.blobUrls[0] }),
    ]);
    const stagedPath = asked[0]?.filename ?? "";
    const [folder, name] = stagedPath.split("/");
    expect(folder).toBe(BROWSER_DOWNLOAD_STAGING_FOLDER);
    expect(BROWSER_DOWNLOAD_STAGED_NAME_PATTERN.test(name ?? "")).toBe(true);
    expect(deliveries).toEqual([
      expect.objectContaining({ report: "started", shownDocument: PDF_URL }),
    ]);

    // Chrome names the download: it is the save, not a download to trace.
    const [save] = savesOf(fake);
    const download = ownDownload(save?.id ?? 0, save?.url ?? "");
    items.set(download.id, download);
    expect(await named(download)).toEqual({
      conflictAction: "uniquify",
      filename: stagedPath,
    });
    await finish(items, download.id, `${DOWNLOADS}/${stagedPath}`);

    expect(reports).toEqual([
      {
        chatId: "thread-7",
        download: {
          bytes: 2048,
          mime: "application/pdf",
          outcome: "saved",
          path: `${DOWNLOADS}/${stagedPath}`,
          // Where the reader's bytes came from.
          sourceUrl: PDF_URL,
          suggestedName: "Judgment 42",
        },
      },
    ]);
    expect(shownDocuments).toEqual([PDF_URL]);
    expect(new Set(deliveries.map(({ deliveryId }) => deliveryId)).size).toBe(
      1,
    );
    // Its bytes are freed once Chrome saved them.
    expect(reader.releases).toEqual([save?.url ?? ""]);
  });

  test("Chrome may name the save before it answers the request", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    const suggestions: (chrome.downloads.FilenameSuggestion | undefined)[] = [];
    fake.chromeDownloads.start = async (options) => {
      lastDownloadId += 1;
      const download = ownDownload(lastDownloadId, options.url);
      fake.items.set(download.id, download);
      suggestions.push(await named(download));
      return download.id;
    };

    await saveShownPdf(shownPdf());
    await finish(fake.items, lastDownloadId, `${DOWNLOADS}/staged.pdf`);

    expect(suggestions).toEqual([
      expect.objectContaining({ conflictAction: "uniquify" }),
    ]);
    expect(fake.reports.map(({ download }) => download.outcome)).toEqual([
      "saved",
    ]);
  });

  test.each([
    ["answers with a redirect", "redirected"],
    ["cannot be fetched again", "interrupted"],
    ["is larger than the limit", "too-large"],
  ] as const)(
    "a PDF whose address %s is refused, and Chrome is asked for nothing",
    async (_name, reason) => {
      const fake = installFakeChrome(DESKTOP_CHAT);
      fake.reader.answer = () => ({ reason, type: "refused" });

      await saveShownPdf(shownPdf());

      expect(fake.events).toEqual([]);
      expect(fake.reports.map(({ download }) => download)).toEqual([
        {
          outcome: "stopped",
          reason,
          sourceUrl: PDF_URL,
          suggestedName: "Judgment 42",
        },
      ]);
      expect(fake.deliveries.map(({ report }) => report)).toEqual([
        "started",
        "settled",
      ]);
    },
  );

  test("once per address in a run: showing it again reads and saves nothing more", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);

    await saveShownPdf(shownPdf());
    await saveShownPdf(shownPdf({ url: `${PDF_URL}#page=9` }));
    expect(fake.reader.reads).toHaveLength(1);
    expect(fake.events).toHaveLength(1);

    // Another run of the chat saves its own copy.
    await saveShownPdf(shownPdf({ turnId: "run-2" }));
    expect(fake.reader.reads).toHaveLength(2);

    for (const { id, url } of savesOf(fake)) {
      fake.items.set(id, ownDownload(id, url));
      // await-in-loop: each settles in turn, as Chrome reports them.
      await finish(fake.items, id, `${DOWNLOADS}/staged-${String(id)}.pdf`);
    }
  });

  test("under the web connection, or for another chat, nothing is read or saved", async () => {
    const web = installFakeChrome({ type: "web" });
    await saveShownPdf(shownPdf());
    expect(web.reader.reads).toEqual([]);
    expect(web.deliveries).toEqual([]);

    const offline = installFakeChrome({ ...DESKTOP_CHAT, link: "offline" });
    await saveShownPdf(shownPdf());
    expect(offline.reader.reads).toEqual([]);

    const other = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf({ ...shownPdf(), controllerId: "desktop:thread-8" });
    await saveShownPdf({ ...shownPdf(), controllerId: "web-connection" });
    expect(other.reader.reads).toEqual([]);
    expect(other.deliveries).toEqual([]);
  });

  test("a download Chrome refuses to start is reported interrupted and its bytes freed", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    fake.chromeDownloads.start = async () => {
      throw new TypeError("Invalid URL");
    };

    await saveShownPdf(shownPdf());

    expect(fake.reports.map(({ download }) => download)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "interrupted" }),
    ]);
    expect(fake.reader.releases).toEqual(fake.reader.blobUrls);
  });

  test("a save counts against the running limit, and a PDF stopped for it is tried again", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    const addresses = Array.from(
      { length: MAX_RUNNING_DELIVERIES + 1 },
      (_, index) => `${PDF_URL}/${String(index)}`,
    );
    for (const url of addresses) {
      // await-in-loop: each read finds its PDF in turn.
      await saveShownPdf(shownPdf({ url }));
    }
    expect(fake.events).toHaveLength(MAX_RUNNING_DELIVERIES);
    expect(fake.reports.map(({ download }) => download)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "too-many" }),
    ]);

    // One settles; the stopped PDF, shown again, is saved now.
    const [first] = savesOf(fake);
    fake.items.set(
      first?.id ?? 0,
      ownDownload(first?.id ?? 0, first?.url ?? ""),
    );
    await finish(fake.items, first?.id ?? 0, `${DOWNLOADS}/staged-first.pdf`);
    await saveShownPdf(shownPdf({ url: addresses.at(-1) ?? PDF_URL }));
    expect(fake.events).toHaveLength(MAX_RUNNING_DELIVERIES + 1);

    for (const { id, url } of savesOf(fake).slice(1)) {
      fake.items.set(id, ownDownload(id, url));
      // await-in-loop: each settles in turn, as Chrome reports them.
      await finish(fake.items, id, `${DOWNLOADS}/staged-${String(id)}.pdf`);
    }
  });

  test("a PDF saved already in this run is never refused for the limit when shown again", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf(shownPdf());
    const [saved] = savesOf(fake);
    fake.items.set(
      saved?.id ?? 0,
      ownDownload(saved?.id ?? 0, saved?.url ?? ""),
    );
    await finish(fake.items, saved?.id ?? 0, `${DOWNLOADS}/staged.pdf`);
    // Every slot is taken by other PDFs.
    for (let index = 0; index < MAX_RUNNING_DELIVERIES; index += 1) {
      // await-in-loop: each read finds its PDF in turn.
      await saveShownPdf(shownPdf({ url: `${PDF_URL}/${String(index)}` }));
    }
    const before = fake.reports.length;

    await saveShownPdf(shownPdf());

    expect(fake.reports).toHaveLength(before);
    expect(fake.reader.reads.filter(({ url }) => url === PDF_URL)).toHaveLength(
      1,
    );
    for (const { id, url } of savesOf(fake).slice(1)) {
      fake.items.set(id, ownDownload(id, url));
      // await-in-loop: each settles in turn, as Chrome reports them.
      await finish(fake.items, id, `${DOWNLOADS}/staged-${String(id)}.pdf`);
    }
  });

  test("a save Chrome says is too large is stopped and the chat hears why", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf(shownPdf());
    const [save] = savesOf(fake);
    const download = {
      ...ownDownload(save?.id ?? 0, save?.url ?? ""),
      totalBytes: BROWSER_CONTROL_LIMITS.downloadBytes + 1,
    };
    fake.items.set(download.id, download);

    expect(await named(download)).toBeUndefined();
    expect(fake.events).toContain(`cancel:${String(download.id)}`);
    expect(fake.reports.map(({ download: reported }) => reported)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "too-large" }),
    ]);
  });

  test("a save Chrome takes from anywhere but the reader's bytes is refused, and a file it finished is removed", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf(shownPdf());
    await saveShownPdf(shownPdf({ url: `${PDF_URL}/annex` }));
    const [first, second] = savesOf(fake);
    const elsewhere = "https://10.0.0.8/42.pdf";
    // Chrome reports another address before naming the first.
    const moved = {
      ...ownDownload(first?.id ?? 0, first?.url ?? ""),
      finalUrl: elsewhere,
    };
    fake.items.set(moved.id, moved);
    expect(await named(moved)).toBeUndefined();
    // The second finishes, and only then names another address.
    const late = ownDownload(second?.id ?? 0, second?.url ?? "");
    fake.items.set(late.id, late);
    await named(late);
    fake.items.set(late.id, {
      ...late,
      filename: `${DOWNLOADS}/staged-second.pdf`,
      finalUrl: elsewhere,
      state: "complete",
    });
    await reportDeliveredDownload({
      id: late.id,
      state: { current: "complete", previous: "in_progress" },
    });

    expect(fake.events).toContain(`cancel:${String(moved.id)}`);
    expect(fake.events).toContain(`remove:${String(late.id)}`);
    expect(fake.events).not.toContain(`remove:${String(moved.id)}`);
    expect(fake.reports.map(({ download }) => download)).toEqual([
      expect.objectContaining({ reason: "redirected", sourceUrl: elsewhere }),
      expect.objectContaining({ reason: "redirected", sourceUrl: elsewhere }),
    ]);
    expect(fake.reader.releases.toSorted()).toEqual(
      [first?.url ?? "", second?.url ?? ""].toSorted(),
    );
  });

  test("a save Chrome never settles is stopped at its deadline, its slot and bytes freed", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf(shownPdf());
    const [stalled] = savesOf(fake);
    expect(fake.deliveryTimers.map(({ ms }) => ms)).toEqual([
      DELIVERY_TIMEOUT_MS,
    ]);
    const stopped = Promise.withResolvers<undefined>();
    fake.chromeDownloads.onCancel = () => {
      stopped.resolve(undefined);
    };

    for (const { task } of [...fake.deliveryTimers]) {
      task();
    }
    await stopped.promise;

    expect(fake.events).toContain(`cancel:${String(stalled?.id ?? 0)}`);
    expect(fake.reports.map(({ download }) => download)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "interrupted" }),
    ]);
    expect(fake.reader.releases).toEqual([stalled?.url ?? ""]);
    expect(fake.deliveryTimers).toEqual([]);
  });

  test("a save that settles ends its deadline", async () => {
    const fake = installFakeChrome(DESKTOP_CHAT);
    await saveShownPdf(shownPdf());
    const [save] = savesOf(fake);
    fake.items.set(save?.id ?? 0, ownDownload(save?.id ?? 0, save?.url ?? ""));
    await finish(fake.items, save?.id ?? 0, `${DOWNLOADS}/staged.pdf`);

    expect(fake.deliveryTimers).toEqual([]);
  });

  test("a download of the extension's that no save explains is stopped", async () => {
    const { events, items, reports } = installFakeChrome(DESKTOP_CHAT);
    const stray = ownDownload(
      1201,
      "blob:chrome-extension://stella-extension/unknown",
    );
    items.set(stray.id, stray);

    expect(await named(stray)).toBeUndefined();
    expect(events).toContain("cancel:1201");
    expect(reports).toEqual([]);
  });
});

describe("what a desktop chat takes", () => {
  const facts = {
    filename: "",
    finalUrl: FILE_URL,
    mime: "application/pdf",
    totalBytes: 2048,
    url: FILE_URL,
  };

  test("a PDF by its type or by its name, never by neither", () => {
    expect(desktopDownloadVerdict(facts, 0)).toEqual({ type: "deliver" });
    expect(
      desktopDownloadVerdict(
        { ...facts, mime: "application/pdf; charset=binary" },
        0,
      ),
    ).toEqual({ type: "deliver" });
    expect(
      desktopDownloadVerdict(
        { ...facts, filename: "Order.PDF", mime: "application/octet-stream" },
        0,
      ),
    ).toEqual({ type: "deliver" });
    expect(
      desktopDownloadVerdict(
        { ...facts, filename: "Order.pdf.exe", mime: "" },
        0,
      ),
    ).toEqual({ reason: "not-pdf", type: "stop" });
  });

  test("not one Chrome says is too large, nor one beyond the running limit", () => {
    expect(
      desktopDownloadVerdict(
        { ...facts, totalBytes: BROWSER_CONTROL_LIMITS.downloadBytes + 1 },
        0,
      ),
    ).toEqual({ reason: "too-large", type: "stop" });
    // Chrome reports an unknown size as zero or less: the file is checked
    // once saved.
    expect(desktopDownloadVerdict({ ...facts, totalBytes: -1 }, 0)).toEqual({
      type: "deliver",
    });
    expect(desktopDownloadVerdict(facts, MAX_RUNNING_DELIVERIES)).toEqual({
      reason: "too-many",
      type: "stop",
    });
  });
});
