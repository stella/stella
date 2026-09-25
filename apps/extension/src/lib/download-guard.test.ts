import { afterEach, describe, expect, test } from "bun:test";

import {
  downloadAction,
  downloadNoticeMessage,
  downloadOwner,
  holdDownloadForJudgement,
  judgeDownload,
  recordDownloadNotice,
  refreshContainedDownloadScope,
  takeDownloadNotices,
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
  test("stops what may not be the user's, and never deletes a file", () => {
    for (const owner of ["ambiguous", "contained", "unknown"] as const) {
      expect(downloadAction(owner, "in_progress")).toBe("cancel");
      expect(downloadAction(owner, "complete")).toBe("keep-and-flag");
    }
    expect(downloadAction("user", "in_progress")).toBe("allow");
    expect(downloadAction("user", "complete")).toBe("allow");
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
  failingTab,
  state = "in_progress",
  userSite = "https://files.example.org/",
}: { failingTab?: number; state?: string; userSite?: string | null } = {}) => {
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
        setBadgeText: async ({ text }: { text: string }) => {
          events.push(`badge:${text}`);
        },
        setTitle: async ({ title }: { title: string }) => {
          events.push(`title:${title}`);
        },
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
      i18n: { getMessage: (name: string) => name },
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
          if (tabId === failingTab) {
            throw new TypeError(`No tab with id: ${tabId}.`);
          }
          if (tabId !== 3 && userSite === null) {
            // The user's tab closed, or moved on to a page with no frames of
            // that site, before the lookup ran.
            return [];
          }
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
      expect(events).toEqual([
        `cancel:${id}`,
        "badge:1",
        "title:downloadStopped",
        "suggest",
      ]);
    });
  }
});

describe("a download of uncertain origin", () => {
  test("the user's source tab closed before the lookup: stopped while running, never deleted", async () => {
    // The user saved it from their tab on the controlled page's site, then
    // closed that tab; only the controlled page's frame still matches.
    for (const [state, id] of [
      ["in_progress", 45],
      ["complete", 46],
    ] as const) {
      const { events, releaseFrames } = installFakeChrome({
        state,
        userSite: null,
      });
      await refreshContainedDownloadScope();
      releaseFrames();
      await judgeDownload({ ...savedByControlledPage(id), state });

      expect(events.filter((event) => event.startsWith("remove"))).toEqual([]);
      expect(events.at(0)).toBe(
        state === "complete" ? "badge:1" : `cancel:${id}`,
      );
      expect(events).toContain(
        state === "complete" ? "title:downloadKept" : "title:downloadStopped",
      );
    }
  });

  test("a failed frame lookup is no evidence: stopped while running, never deleted", async () => {
    for (const [state, id] of [
      ["in_progress", 47],
      ["complete", 48],
    ] as const) {
      const { events, releaseFrames } = installFakeChrome({
        failingTab: 1,
        state,
      });
      await refreshContainedDownloadScope();
      releaseFrames();
      await judgeDownload({
        ...savedByControlledPage(id),
        finalUrl: "blob:https://files.example.org/1a2b",
        state,
        url: "blob:https://files.example.org/1a2b",
      });

      expect(events.filter((event) => event.startsWith("remove"))).toEqual([]);
      expect(events.at(0)).toBe(
        state === "complete" ? "badge:1" : `cancel:${id}`,
      );
    }
  });

  test("the user's own download from their own site goes through", async () => {
    const { events, releaseFrames } = installFakeChrome();
    await refreshContainedDownloadScope();
    releaseFrames();
    await judgeDownload({
      ...savedByControlledPage(49),
      finalUrl: "blob:https://files.example.org/1a2b",
      url: "blob:https://files.example.org/1a2b",
    });

    expect(events).toEqual([]);
  });
});

describe("download notices", () => {
  test("name kept files whenever there are any, alone or beside stopped ones", () => {
    expect(downloadNoticeMessage({ kept: 0, stopped: 0 })).toBe(null);
    expect(downloadNoticeMessage({ kept: 0, stopped: 3 })).toEqual({
      name: "downloadStopped",
      substitutions: ["3"],
    });
    expect(downloadNoticeMessage({ kept: 1, stopped: 0 })).toEqual({
      name: "downloadKept",
      substitutions: ["1"],
    });
    expect(downloadNoticeMessage({ kept: 2, stopped: 1 })).toEqual({
      name: "downloadsStoppedAndKept",
      substitutions: ["1", "2"],
    });
  });

  test("a download with no origin that finished before its cancel is noted as kept", async () => {
    const { events, releaseFrames } = installFakeChrome({ state: "complete" });
    await refreshContainedDownloadScope();
    releaseFrames();
    await judgeDownload({
      ...savedByControlledPage(50),
      finalUrl: "data:text/plain,notes",
      state: "in_progress",
      url: "data:text/plain,notes",
    });

    expect(events).toEqual(["cancel:50", "badge:1", "title:downloadKept"]);
  });
});

describe("recording and taking download notices", () => {
  /**
   * Storage whose every read waits until the test lets it through, so two
   * updates can be made to read before either writes.
   */
  const installGatedStorage = () => {
    const stored: Record<string, unknown> = {};
    const waiting: (() => void)[] = [];
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        action: {
          setBadgeText: async () => undefined,
          setTitle: async () => undefined,
        },
        i18n: { getMessage: (name: string) => name },
        storage: {
          session: {
            get: async (key: string) => {
              await new Promise<void>((resolve) => {
                waiting.push(resolve);
              });
              return { [key]: stored[key] };
            },
            remove: async (key: string) => {
              Reflect.deleteProperty(stored, key);
            },
            set: async (items: Record<string, unknown>) => {
              Object.assign(stored, items);
            },
          },
        },
      },
    });
    /** Lets every read waiting now through, then lets pending work settle. */
    const releaseReads = async () => {
      for (const release of waiting.splice(0)) {
        release();
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    };
    return { releaseReads, stored };
  };

  const settle = async (
    releaseReads: () => Promise<void>,
    work: Promise<unknown>,
  ) => {
    const progress = { done: false };
    void work.then(() => {
      progress.done = true;
      return undefined;
    });
    // Both updates are started before any read is let through.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    for (let round = 0; round < 10; round += 1) {
      if (progress.done) {
        break;
      }
      await releaseReads();
    }
    await work;
  };

  test("a kept and a stopped download recorded at once are both counted", async () => {
    const { releaseReads, stored } = installGatedStorage();
    const both = Promise.all([
      recordDownloadNotice("kept"),
      recordDownloadNotice("stopped"),
    ]);
    await settle(releaseReads, both);

    expect(stored["browserDownloadNotices"]).toEqual({ kept: 1, stopped: 1 });
  });

  test("a kept download recorded while the popup takes the notices is not lost", async () => {
    const { releaseReads, stored } = installGatedStorage();
    stored["browserDownloadNotices"] = { kept: 0, stopped: 1 };
    const taken = takeDownloadNotices();
    const recorded = recordDownloadNotice("kept");
    await settle(releaseReads, Promise.all([taken, recorded]));

    // The popup saw what was there when it asked; the kept file waits for
    // the next time it opens.
    expect(await taken).toEqual({ kept: 0, stopped: 1 });
    expect(stored["browserDownloadNotices"]).toEqual({ kept: 1, stopped: 0 });
  });
});
