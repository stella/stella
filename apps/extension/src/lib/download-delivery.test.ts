import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STAGED_NAME_PATTERN,
  BROWSER_DOWNLOAD_STAGING_FOLDER,
  type BrowserDownload,
} from "@stll/api-contract/browser-control";

import {
  desktopDownloadVerdict,
  holdDownloadForJudgement,
  loadDownloadScope,
  MAX_RUNNING_DELIVERIES,
  reportDeliveredDownload,
  setDownloadReporter,
  setDownloadScope,
} from "./download-guard";

const NOW = 1_794_300_000_000;
const clock = { now: () => NOW };
const FILE_URL = "https://fixture-library.test/decisions/42/file";
const DOWNLOADS = "/Volumes/Work/Downloads";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  setDownloadReporter(() => undefined);
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

type Holder =
  | { type: "web" }
  | { type: "desktop"; chatId: string; link: "connected" | "offline" };

/**
 * Tab 3 is chat's, on the fixture library; tab 1 is the member's. Tab 3
 * navigated to `FILE_URL` a second ago, so a download of it traces to tab 3.
 * `holder` is who holds the browser, as the control record stores it.
 */
const installFakeChrome = (holder: Holder) => {
  const events: string[] = [];
  const items = new Map<number, chrome.downloads.DownloadItem>();
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
        cancel: async (id: number) => {
          events.push(`cancel:${id}`);
          const item = items.get(id);
          if (item !== undefined) {
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
  setDownloadReporter((chatId, download) => {
    reports.push({ chatId, download });
  });
  return { events, items, reports };
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
    const { events, items, reports } = installFakeChrome({
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
