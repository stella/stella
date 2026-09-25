import { afterEach, describe, expect, test } from "bun:test";

import {
  downloadAction,
  downloadOwner,
  holdDownloadForJudgement,
  judgeDownload,
  refreshContainedDownloadScope,
} from "./download-guard";

const origins = {
  contained: new Set([
    "https://portal.example.com",
    "https://files.example.net",
  ]),
  user: new Set(["https://files.example.org", "https://files.example.net"]),
};
const download = (url: string, referrer = "", finalUrl = url) => ({
  finalUrl,
  referrer,
  url,
});

describe("download owner", () => {
  test("a blob only the controlled page or its frames could save is contained", () => {
    expect(
      downloadOwner(download("blob:https://portal.example.com/7f0c"), origins),
    ).toBe("contained");
  });

  test("a site open on both sides is ambiguous, not contained", () => {
    // A cross-origin frame in the controlled tab, and the user's own tab.
    expect(
      downloadOwner(download("blob:https://files.example.net/51aa"), origins),
    ).toBe("ambiguous");
  });

  test("a download traced only to the user's tabs is the user's", () => {
    expect(
      downloadOwner(
        download(
          "https://files.example.org/report.pdf",
          "https://files.example.org/",
        ),
        origins,
      ),
    ).toBe("user");
    expect(
      downloadOwner(
        {
          ...download("data:text/plain;base64,AAAA"),
          byExtensionId: "other-extension",
        },
        origins,
      ),
    ).toBe("user");
  });

  test("a download no open frame accounts for is unknown", () => {
    for (const url of [
      "data:text/plain;base64,AAAA",
      "blob:null/1c2d",
      "blob:https://gone.example.com/9e8f",
    ]) {
      expect(downloadOwner(download(url), origins)).toBe("unknown");
    }
  });
});

describe("download action", () => {
  test("only a download a confined frame alone could start is ever deleted", () => {
    expect(downloadAction("contained", "complete")).toBe("cancel-and-delete");
    expect(downloadAction("contained", "in_progress")).toBe(
      "cancel-and-delete",
    );
    for (const owner of ["ambiguous", "unknown"] as const) {
      expect(downloadAction(owner, "in_progress")).toBe("cancel");
      expect(downloadAction(owner, "complete")).toBe("allow");
    }
    expect(downloadAction("user", "in_progress")).toBe("allow");
  });
});

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

/**
 * Tab 3 is controlled at https://portal.example.com, tab 1 the user's. The
 * frame lookup waits for `releaseFrames`, as a slow one would.
 */
const installFakeChrome = ({
  state = "in_progress",
  userSite = "https://files.example.org/",
}: { state?: string; userSite?: string } = {}) => {
  const events: string[] = [];
  let releaseFrames = (): void => undefined;
  const framesReady = new Promise<void>((resolve) => {
    releaseFrames = resolve;
  });
  const session: Record<string, unknown> = {
    browserContainedTabs: {
      controlledTabId: 3,
      openedTabIds: [],
      userTabIds: [1],
    },
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      action: {
        setBadgeText: async () => undefined,
        setTitle: async () => undefined,
      },
      downloads: {
        cancel: async (id: number) => {
          events.push(`cancel:${id}`);
        },
        removeFile: async (id: number) => {
          events.push(`remove:${id}`);
        },
        search: async ({ id }: { id: number }) => [{ id, state }],
      },
      i18n: { getMessage: () => "stopped" },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(session, items);
          },
        },
      },
      tabs: { query: async () => [{ id: 1 }, { id: 3 }] },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => {
          await framesReady;
          return [
            {
              frameId: 0,
              url: tabId === 3 ? "https://portal.example.com/" : userSite,
            },
          ];
        },
      },
    },
  });
  return { events, releaseFrames };
};

/** A small file the controlled page saves; each test uses its own id. */
const savedByControlledPage = (id: number): chrome.downloads.DownloadItem => ({
  bytesReceived: 0,
  canResume: false,
  danger: "safe",
  exists: true,
  fileSize: 10,
  filename: "",
  finalUrl: "blob:https://portal.example.com/7f0c",
  id,
  incognito: false,
  mime: "text/plain",
  paused: false,
  referrer: "",
  startTime: "2026-09-25T00:00:00.000Z",
  state: "in_progress",
  totalBytes: 10,
  url: "blob:https://portal.example.com/7f0c",
});

describe("holding a download for its judgement", () => {
  for (const [order, id] of [
    ["created first", 41],
    ["filename first", 42],
  ] as const) {
    test(`the file name waits for the verdict (${order})`, async () => {
      const saved = savedByControlledPage(id);
      const { events, releaseFrames } = installFakeChrome();
      await refreshContainedDownloadScope();
      const suggested = new Promise<void>((resolve) => {
        const suggest = () => {
          events.push("suggest");
          resolve();
        };
        if (order === "created first") {
          void judgeDownload(saved);
          holdDownloadForJudgement(saved, suggest);
        } else {
          holdDownloadForJudgement(saved, suggest);
          void judgeDownload(saved);
        }
      });
      // The frame lookup is still running: nothing may be suggested yet.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(events).toEqual([]);

      releaseFrames();
      await suggested;
      expect(events).toEqual([`cancel:${id}`, "suggest"]);
    });
  }
});

describe("a finished download the user may have started", () => {
  test("is kept when the user has the same site open", async () => {
    const { events, releaseFrames } = installFakeChrome({
      state: "complete",
      userSite: "https://portal.example.com/",
    });
    await refreshContainedDownloadScope();
    releaseFrames();

    await judgeDownload({
      ...savedByControlledPage(43),
      state: "complete",
    });
    expect(events).toEqual([]);
  });

  test("is deleted when only the controlled page could have started it", async () => {
    const { events, releaseFrames } = installFakeChrome({ state: "complete" });
    await refreshContainedDownloadScope();
    releaseFrames();

    await judgeDownload({
      ...savedByControlledPage(44),
      state: "complete",
    });
    expect(events).toEqual(["cancel:44", "remove:44"]);
  });
});
