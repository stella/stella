import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_LIMITS,
  type BrowserExtensionDownloadMessage,
  decodeDownloadChunk,
  encodeDownloadChunk,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";
import { BROWSER_DOWNLOAD_FILE_MAX_BYTES } from "@stll/api-contract/browser-downloads";

import {
  holdDownloadForJudgement,
  loadDownloadScope,
  reportDeliveredDownload,
  setDownloadScope,
  setShownPdfReader,
  setWebDownloadSend,
} from "./download-guard";
import type { ShownPdfRead } from "./shown-pdf-reader";
import type { WebDownloadTarget } from "./web-download-target";

// A download chat's tab makes while the web connection holds the browser:
// the real judgement, with Chrome, the offscreen reader and the stella
// tab's channel faked at their edges.

const NOW = 1_794_300_000_000;
const clock = { now: () => NOW };
const PAGE_URL = "https://fixture-library.test/decisions/42";
const FILE_URL = "https://fixture-library.test/decisions/42/file";
const CONTROLLER_ID = "controller-1";

const TARGET: WebDownloadTarget = {
  controllerId: CONTROLLER_ID,
  documentId: "stella-document-1",
  tabId: 9,
  turnId: "turn-7",
};

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  setShownPdfReader({
    read: async () => ({ reason: "interrupted", type: "refused" }),
    release: async () => undefined,
    slice: async () => null,
  });
  setWebDownloadSend(async () => await Promise.resolve(false));
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

/** Bytes that start as a PDF's, `size` long. */
const pdfBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  for (let index = 9; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
};

let lastDownloadId = 7000;
let lastBlob = 0;

type Setup = {
  /** Who holds the browser: the web connection, or a desktop chat. */
  holder?: "desktop" | "web";
  /** The web connection's last command; null when it ran none. */
  target?: WebDownloadTarget | null;
  /** The paired connection now. */
  controllerId?: string;
  /** What the controlled tab shows. */
  pageUrl?: string;
  /** What fetching the file once more returns. */
  fetched?: Uint8Array | ShownPdfRead;
  /** The tab whose navigation the download traces to. */
  navigatedTab?: number;
};

const install = ({
  controllerId = CONTROLLER_ID,
  fetched = pdfBytes(2048),
  holder = "web",
  navigatedTab = 3,
  pageUrl = PAGE_URL,
  target = TARGET,
}: Setup = {}) => {
  const events: string[] = [];
  const items = new Map<number, chrome.downloads.DownloadItem>();
  const session: Record<string, unknown> = {
    browserContainedTabs: {
      controlledTabId: 3,
      openedTabIds: [],
      userTabIds: [1],
    },
    browserController: { controllerId, origin: "https://stella.test" },
    browserRecentNavigations: [
      { at: NOW - 1000, tabId: navigatedTab, url: FILE_URL },
    ],
    ...(target === null ? {} : { browserWebDownloadTarget: target }),
    ...(holder === "desktop"
      ? {
          browserControlOwner: "desktop:thread-7",
          browserDesktopLink: "connected",
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
          events.push(`cancel:${String(id)}`);
          const item = items.get(id);
          if (item !== undefined && item.state !== "complete") {
            items.set(id, { ...item, state: "interrupted" });
          }
        },
        removeFile: async (id: number) => {
          events.push(`remove:${String(id)}`);
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
      tabs: {
        get: async (tabId: number) => ({
          id: tabId,
          url: tabId === 3 ? pageUrl : "https://files.example.org/",
        }),
        query: async () => [{ id: 1 }, { id: 3 }],
      },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => [
          {
            frameId: 0,
            url: tabId === 3 ? pageUrl : "https://files.example.org/",
          },
        ],
      },
    },
  });

  const kept = new Map<string, Uint8Array>();
  const released = Promise.withResolvers<undefined>();
  const reader = {
    reads: new Array<{ maxBytes: number; url: string }>(),
    releases: new Array<string>(),
  };
  setShownPdfReader({
    read: async (url, maxBytes) => {
      reader.reads.push({ maxBytes, url });
      if (!(fetched instanceof Uint8Array)) {
        return fetched;
      }
      lastBlob += 1;
      const downloadUrl = `blob:chrome-extension://stella-extension/${String(lastBlob)}`;
      kept.set(downloadUrl, fetched);
      return {
        bytes: fetched.byteLength,
        downloadUrl,
        fetchedUrl: url,
        type: "read",
      };
    },
    release: async (downloadUrl) => {
      reader.releases.push(downloadUrl);
      kept.delete(downloadUrl);
      released.resolve(undefined);
    },
    slice: async (downloadUrl, start, end) => {
      const bytes = kept.get(downloadUrl);
      return bytes === undefined
        ? null
        : encodeDownloadChunk(bytes.subarray(start, end));
    },
  });

  const sent: { target: WebDownloadTarget; message: unknown }[] = [];
  const ended = Promise.withResolvers<undefined>();
  setWebDownloadSend(async (to, message: BrowserExtensionDownloadMessage) => {
    sent.push({ message, target: to });
    if (message.type === "download-end") {
      ended.resolve(undefined);
    }
    return await Promise.resolve(true);
  });
  return {
    end: ended.promise,
    events,
    items,
    reader,
    /** Settles once the reader freed what it kept, the hand-over's last step. */
    released: released.promise,
    sent,
  };
};

const fileDownload = (
  overrides: Partial<chrome.downloads.DownloadItem> = {},
): chrome.downloads.DownloadItem => {
  lastDownloadId += 1;
  return {
    bytesReceived: 0,
    canResume: false,
    danger: "safe",
    exists: true,
    fileSize: 0,
    filename: "Judgment 42.pdf",
    finalUrl: FILE_URL,
    id: lastDownloadId,
    incognito: false,
    mime: "application/pdf",
    paused: false,
    referrer: "",
    startTime: "2026-11-25T09:30:00.000Z",
    state: "in_progress",
    totalBytes: 2048,
    url: FILE_URL,
    ...overrides,
  };
};

const judged = async (
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

/** Each message as the stella tab's content script reads it. */
const parsed = (sent: { message: unknown }[]) =>
  sent.map(({ message }) => parseBrowserExtensionResponse(message));

describe("a download from chat's tab under the web connection", () => {
  test("a PDF is fetched once more and handed to the stella tab in pieces, and Chrome saves nothing", async () => {
    const bytes = pdfBytes(BROWSER_CONTROL_LIMITS.downloadChunkBytes + 1000);
    const { end, events, items, reader, released, sent } = install({
      fetched: bytes,
    });
    await loadDownloadScope();
    const download = fileDownload({ totalBytes: bytes.byteLength });
    items.set(download.id, download);

    expect(await judged(download)).toBeUndefined();
    await end;

    // Chrome's own copy is stopped, and the member is not told a download
    // was stopped: the chat has it.
    expect(events).toEqual([`cancel:${String(download.id)}`]);
    expect(reader.reads).toEqual([
      { maxBytes: BROWSER_DOWNLOAD_FILE_MAX_BYTES, url: FILE_URL },
    ]);
    const messages = parsed(sent);
    expect(messages.every((message) => message !== null)).toBe(true);
    expect(sent.map(({ target }) => target)).toEqual(sent.map(() => TARGET));
    const [started, first, second, last] = messages;
    expect(started).toMatchObject({
      controllerId: CONTROLLER_ID,
      pageUrl: PAGE_URL,
      sourceUrl: FILE_URL,
      suggestedName: "Judgment 42.pdf",
      turnId: "turn-7",
      type: "download-started",
    });
    expect(first).toMatchObject({ index: 0, type: "download-chunk" });
    expect(second).toMatchObject({ index: 1, type: "download-chunk" });
    expect(last).toMatchObject({
      end: { bytes: bytes.byteLength, chunks: 2, outcome: "captured" },
      type: "download-end",
    });
    const deliveryIds = new Set(
      messages.map((message) =>
        message !== null && "deliveryId" in message ? message.deliveryId : "",
      ),
    );
    expect(deliveryIds.size).toBe(1);
    // The pieces are the file, byte for byte.
    const pieces = [first, second].map((message) =>
      message?.type === "download-chunk"
        ? (decodeDownloadChunk(message.data) ?? new Uint8Array())
        : new Uint8Array(),
    );
    expect(Buffer.concat(pieces).equals(Buffer.from(bytes))).toBe(true);
    // The kept bytes are freed once the last piece is sent.
    await released;
    expect(reader.releases).toHaveLength(1);
  });

  test("a file from another site than the page names no page", async () => {
    const { end, items, sent } = install({
      pageUrl: "https://portal.example.com/case/9",
    });
    await loadDownloadScope();
    const download = fileDownload();
    items.set(download.id, download);

    await judged(download);
    await end;

    expect(parsed(sent).at(0)).toMatchObject({
      pageUrl: null,
      type: "download-started",
    });
  });

  test("a page's own blob: address cannot be fetched again: the chat hears why", async () => {
    const { events, items, reader, sent } = install();
    await loadDownloadScope();
    const download = fileDownload({
      finalUrl: "blob:https://fixture-library.test/7d1c",
      url: "blob:https://fixture-library.test/7d1c",
    });
    items.set(download.id, download);
    // The page that created it is chat's.
    setDownloadScope({ contained: [3], user: [1] });

    expect(await judged(download)).toBeUndefined();

    expect(reader.reads).toEqual([]);
    expect(events).toContain(`cancel:${String(download.id)}`);
    expect(parsed(sent).map((message) => message?.type)).toEqual([
      "download-started",
      "download-end",
    ]);
    expect(parsed(sent).at(1)).toMatchObject({
      end: { outcome: "stopped", reason: "not-refetchable" },
    });
  });

  test("a fetch that does not return a PDF ends as not refetchable and frees what it kept", async () => {
    const { end, items, reader, released, sent } = install({
      fetched: new TextEncoder().encode("<html>Sign in to continue</html>"),
    });
    await loadDownloadScope();
    const download = fileDownload();
    items.set(download.id, download);

    await judged(download);
    await end;

    expect(parsed(sent).map((message) => message?.type)).toEqual([
      "download-started",
      "download-end",
    ]);
    expect(parsed(sent).at(1)).toMatchObject({
      end: { outcome: "stopped", reason: "not-refetchable" },
    });
    await released;
    expect(reader.releases).toHaveLength(1);
  });

  test("a redirect on the fetch ends with its reason, never followed", async () => {
    const { end, items, sent } = install({
      fetched: { reason: "redirected", type: "refused" },
    });
    await loadDownloadScope();
    const download = fileDownload();
    items.set(download.id, download);

    await judged(download);
    await end;

    expect(parsed(sent).at(1)).toMatchObject({
      end: { outcome: "stopped", reason: "redirected" },
    });
  });

  test("a PDF larger than what is filed is stopped before any fetch", async () => {
    const { events, items, reader, sent } = install();
    await loadDownloadScope();
    const download = fileDownload({
      totalBytes: BROWSER_DOWNLOAD_FILE_MAX_BYTES + 1,
    });
    items.set(download.id, download);

    await judged(download);

    expect(reader.reads).toEqual([]);
    expect(events).toEqual([`cancel:${String(download.id)}`, "badge:1"]);
    expect(parsed(sent).at(1)).toMatchObject({
      end: { outcome: "stopped", reason: "too-large" },
    });
  });

  test("before the web connection ran a command, or for an earlier pairing, the download is stopped and nobody is told", async () => {
    for (const setup of [
      { target: null },
      { controllerId: "controller-2" },
    ] satisfies Setup[]) {
      const { events, items, reader, sent } = install(setup);
      // await-in-loop: each case installs its own Chrome.
      await loadDownloadScope();
      const download = fileDownload();
      items.set(download.id, download);

      expect(await judged(download)).toBeUndefined();

      expect(events).toEqual([`cancel:${String(download.id)}`, "badge:1"]);
      expect(reader.reads).toEqual([]);
      expect(sent).toEqual([]);
    }
  });

  test("a download from the member's own tab is left alone and never handed on", async () => {
    const { events, items, reader, sent } = install({ navigatedTab: 1 });
    await loadDownloadScope();
    const download = fileDownload();
    items.set(download.id, download);

    expect(await judged(download)).toBeUndefined();

    expect(events).toEqual([]);
    expect(reader.reads).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("while a desktop chat holds the browser, nothing goes to a stella tab", async () => {
    const { items, reader, sent } = install({ holder: "desktop" });
    await loadDownloadScope();
    const download = fileDownload();
    items.set(download.id, download);

    // The desktop chat takes it into its staging folder instead.
    expect(await judged(download)).toMatchObject({
      conflictAction: "uniquify",
    });

    expect(reader.reads).toEqual([]);
    expect(sent).toEqual([]);
    // Chrome gives up on it, which frees the desktop chat's slot.
    items.set(download.id, { ...download, state: "interrupted" });
    await reportDeliveredDownload({
      id: download.id,
      state: { current: "interrupted", previous: "in_progress" },
    });
  });
});
