import { afterEach, describe, expect, test } from "bun:test";

import { downloadAction, NO_DOWNLOAD_RECEIVER } from "./download-guard";
import {
  type DownloadEvidence,
  type DownloadOwner,
  NAVIGATION_LIMIT,
  NAVIGATION_WINDOW_MS,
  type RecordedNavigation,
  recordNavigation,
  resolveDownloadOwner,
  traceDownload,
} from "./download-trace";

const NOW = 1_794_300_000_000;
const clock = { now: () => NOW };
const USER_TAB = 1;
const CONTROLLED_TAB = 3;
const OPENED_TAB = 4;

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

const installRuntime = (): void => {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { id: "stella-extension" } },
  });
};

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

const download = (
  url: string,
  {
    finalUrl = url,
    referrer = "",
  }: { finalUrl?: string; referrer?: string } = {},
) => ({ finalUrl, referrer, url });

const navigation = (
  tabId: number,
  url: string,
  at = NOW - 1000,
): RecordedNavigation => ({ at, tabId, url });

/** The user's tab is on drive.google.com; stella controls a portal tab. */
const evidence = (
  overrides: Partial<DownloadEvidence> = {},
): DownloadEvidence => ({
  frames: {
    contained: new Set(["https://portal.example.com"]),
    user: new Set(["https://drive.google.com"]),
  },
  navigations: [],
  now: NOW,
  userTabIds: [USER_TAB],
  ...overrides,
});

/** The traced owner as a plain name, to compare with one. */
const ownerOf = (
  ...args: Parameters<typeof resolveDownloadOwner>
): DownloadOwner => resolveDownloadOwner(...args);

const tracedOwnerOf = async (
  ...args: Parameters<typeof traceDownload>
): Promise<DownloadOwner> => await traceDownload(...args);

const FILE_URL =
  "https://drive.usercontent.google.com/download?id=1a2b3c&export=download";
const PAYLOAD_URL = "https://payload.example.net/notes.bin";

describe("tracing a download a navigation turned into", () => {
  test("a file a frame in the user's tab loads from another host is the user's, with no referrer", () => {
    installRuntime();
    expect(
      ownerOf(
        download(FILE_URL),
        evidence({ navigations: [navigation(USER_TAB, FILE_URL)] }),
      ),
    ).toBe("user");
  });

  test("a file the controlled tab, a frame in it or a tab it opened loads is contained, with no referrer", () => {
    installRuntime();
    for (const tabId of [CONTROLLED_TAB, OPENED_TAB]) {
      expect(
        ownerOf(
          download(PAYLOAD_URL),
          evidence({ navigations: [navigation(tabId, PAYLOAD_URL)] }),
        ),
      ).toBe("contained");
    }
  });

  test("a redirect is traced by the address the navigation started at, or the one it ended at", () => {
    installRuntime();
    const start = "https://payload.example.net/redirect";
    expect(
      ownerOf(
        download(start, { finalUrl: PAYLOAD_URL }),
        evidence({ navigations: [navigation(CONTROLLED_TAB, start)] }),
      ),
    ).toBe("contained");
    expect(
      ownerOf(
        download(start, { finalUrl: PAYLOAD_URL }),
        evidence({ navigations: [navigation(CONTROLLED_TAB, PAYLOAD_URL)] }),
      ),
    ).toBe("contained");
  });

  test("a fragment does not hide a match", () => {
    installRuntime();
    expect(
      ownerOf(
        download(`${PAYLOAD_URL}#page=2`),
        evidence({
          navigations: [navigation(CONTROLLED_TAB, PAYLOAD_URL)],
        }),
      ),
    ).toBe("contained");
  });

  test("tabs on both sides navigating to it make it ambiguous", () => {
    installRuntime();
    expect(
      ownerOf(
        download(FILE_URL),
        evidence({
          navigations: [
            navigation(USER_TAB, FILE_URL),
            navigation(CONTROLLED_TAB, FILE_URL),
          ],
        }),
      ),
    ).toBe("ambiguous");
  });

  test("a navigation wins over open frames of the same site", () => {
    installRuntime();
    // The user has the payload's site open; the controlled tab navigated.
    expect(
      ownerOf(
        download(PAYLOAD_URL),
        evidence({
          frames: {
            contained: new Set(),
            user: new Set(["https://payload.example.net"]),
          },
          navigations: [navigation(CONTROLLED_TAB, PAYLOAD_URL)],
        }),
      ),
    ).toBe("contained");
  });

  test("a navigation older than the window explains nothing", () => {
    installRuntime();
    const stale = navigation(
      USER_TAB,
      FILE_URL,
      NOW - NAVIGATION_WINDOW_MS - 1,
    );
    expect(
      ownerOf(download(FILE_URL), evidence({ navigations: [stale] })),
    ).toBe("unexplained");
    const fresh = navigation(USER_TAB, FILE_URL, NOW - NAVIGATION_WINDOW_MS);
    expect(
      ownerOf(download(FILE_URL), evidence({ navigations: [fresh] })),
    ).toBe("user");
  });
});

describe("tracing a download no navigation explains", () => {
  test("a blob only the controlled page or its frames could save is contained", () => {
    installRuntime();
    expect(
      ownerOf(download("blob:https://portal.example.com/7f0c"), evidence()),
    ).toBe("contained");
  });

  test("a site open on both sides is ambiguous", () => {
    installRuntime();
    expect(
      ownerOf(
        download("blob:https://drive.google.com/51aa"),
        evidence({
          frames: {
            contained: new Set(["https://drive.google.com"]),
            user: new Set(["https://drive.google.com"]),
          },
        }),
      ),
    ).toBe("ambiguous");
  });

  test("a link the user saves from their own page traces by its referrer", () => {
    installRuntime();
    expect(
      ownerOf(
        download(PAYLOAD_URL, { referrer: "https://drive.google.com/" }),
        evidence(),
      ),
    ).toBe("user");
  });

  test("another extension's download is the user's, whatever its origin", () => {
    installRuntime();
    expect(
      ownerOf(
        {
          ...download("data:text/plain;base64,AAAA"),
          byExtensionId: "other-extension",
        },
        evidence(),
      ),
    ).toBe("user");
  });

  test("a download with no web origin is untraceable, even under stella's own id", () => {
    installRuntime();
    for (const url of ["data:text/plain;base64,AAAA", "blob:null/1c2d"]) {
      expect(ownerOf(download(url), evidence())).toBe("untraceable");
      expect(
        ownerOf(
          { ...download(url), byExtensionId: "stella-extension" },
          evidence(),
        ),
      ).toBe("untraceable");
    }
  });

  test("a web download nothing accounts for is unexplained", () => {
    installRuntime();
    for (const url of [FILE_URL, "blob:https://gone.example.com/9e8f"]) {
      expect(ownerOf(download(url), evidence())).toBe("unexplained");
    }
  });

  test("a failed frame lookup is no evidence: unexplained", () => {
    installRuntime();
    expect(
      ownerOf(
        download("blob:https://drive.google.com/51aa"),
        evidence({ frames: null }),
      ),
    ).toBe("unexplained");
  });
});

describe("what happens to each owner while stella controls a tab", () => {
  const owners: Record<
    DownloadOwner,
    ReturnType<typeof resolveDownloadOwner>
  > = {
    ambiguous: resolveDownloadOwner(
      download(FILE_URL),
      evidence({
        navigations: [
          navigation(USER_TAB, FILE_URL),
          navigation(CONTROLLED_TAB, FILE_URL),
        ],
      }),
    ),
    contained: resolveDownloadOwner(
      download(PAYLOAD_URL),
      evidence({ navigations: [navigation(CONTROLLED_TAB, PAYLOAD_URL)] }),
    ),
    unexplained: resolveDownloadOwner(download(FILE_URL), evidence()),
    untraceable: resolveDownloadOwner(
      download("data:text/plain,notes"),
      evidence(),
    ),
    user: resolveDownloadOwner(
      download(FILE_URL),
      evidence({ navigations: [navigation(USER_TAB, FILE_URL)] }),
    ),
  };

  test("each example traces to the owner it stands for", () => {
    for (const [name, owner] of Object.entries(owners)) {
      expect<string>(owner).toBe(name);
    }
  });

  const desktopTakes = {
    chatId: "thread-1",
    type: "desktop",
    verdict: { type: "deliver" },
  } as const;

  test("what may be the user's goes through", () => {
    for (const owner of [owners.ambiguous, owners.user]) {
      for (const state of ["in_progress", "interrupted", "complete"] as const) {
        expect(downloadAction(owner, state, NO_DOWNLOAD_RECEIVER)).toBe(
          "allow",
        );
        expect(downloadAction(owner, state, desktopTakes)).toBe("allow");
      }
    }
  });

  test("what only confined tabs or nobody explains is stopped, and a finished file is kept", () => {
    for (const owner of [
      owners.contained,
      owners.unexplained,
      owners.untraceable,
    ]) {
      expect(downloadAction(owner, "in_progress", NO_DOWNLOAD_RECEIVER)).toBe(
        "cancel",
      );
      expect(downloadAction(owner, "interrupted", NO_DOWNLOAD_RECEIVER)).toBe(
        "cancel",
      );
      expect(downloadAction(owner, "complete", NO_DOWNLOAD_RECEIVER)).toBe(
        "keep-and-flag",
      );
    }
  });

  test("only a download traced to chat's tabs reaches a desktop chat", () => {
    expect(downloadAction(owners.contained, "in_progress", desktopTakes)).toBe(
      "deliver",
    );
    expect(
      downloadAction(owners.contained, "in_progress", {
        ...desktopTakes,
        verdict: { reason: "not-pdf", type: "stop" },
      }),
    ).toBe("refuse");
    // Chrome skipped the hold: the file is already where Chrome put it.
    expect(downloadAction(owners.contained, "complete", desktopTakes)).toBe(
      "keep-and-flag",
    );
    for (const owner of [owners.unexplained, owners.untraceable]) {
      expect(downloadAction(owner, "in_progress", desktopTakes)).toBe("cancel");
    }
  });
});

/** Session storage shared across worker lifetimes, as Chrome keeps it. */
const installStorage = (
  session: Record<string, unknown>,
  { userSite = "https://drive.google.com/" }: { userSite?: string } = {},
): void => {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: { id: "stella-extension" },
      storage: {
        session: {
          get: async (key: string) => ({
            [key]: structuredClone(session[key]),
          }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(session, structuredClone(items));
          },
        },
      },
      tabs: { query: async () => [{ id: USER_TAB }, { id: CONTROLLED_TAB }] },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => [
          {
            frameId: 0,
            url:
              tabId === CONTROLLED_TAB
                ? "https://portal.example.com/"
                : userSite,
          },
        ],
      },
    },
  });
};

const owners = { contained: [CONTROLLED_TAB], user: [USER_TAB] };

describe("the navigation window", () => {
  test("a navigation recorded before the worker stopped still traces the download after it starts again", async () => {
    const session: Record<string, unknown> = {};
    installStorage(session);
    await recordNavigation({
      tabId: USER_TAB,
      timeStamp: NOW,
      url: `${FILE_URL}#top`,
    });
    // A new worker: nothing in memory, the same session storage.
    installStorage(structuredClone(session));
    expect(await tracedOwnerOf(download(FILE_URL), owners, clock)).toBe("user");
  });

  test("navigations recorded at once are all kept", async () => {
    const session: Record<string, unknown> = {};
    installStorage(session);
    const at = NOW;
    await Promise.all([
      recordNavigation({ tabId: USER_TAB, timeStamp: at, url: FILE_URL }),
      recordNavigation({
        tabId: CONTROLLED_TAB,
        timeStamp: at,
        url: PAYLOAD_URL,
      }),
    ]);
    expect(await tracedOwnerOf(download(FILE_URL), owners, clock)).toBe("user");
    expect(await tracedOwnerOf(download(PAYLOAD_URL), owners, clock)).toBe(
      "contained",
    );
  });

  test("expired and excess navigations are dropped, the newest kept", async () => {
    const at = NOW;
    const session: Record<string, unknown> = {
      browserRecentNavigations: [
        navigation(USER_TAB, FILE_URL, at - NAVIGATION_WINDOW_MS - 1),
        ...Array.from({ length: NAVIGATION_LIMIT }, (_, index) =>
          navigation(CONTROLLED_TAB, `https://site.example.org/${index}`, at),
        ),
      ],
    };
    installStorage(session);
    await recordNavigation({
      tabId: USER_TAB,
      timeStamp: at,
      url: PAYLOAD_URL,
    });
    const stored = session["browserRecentNavigations"];
    expect(Array.isArray(stored) ? stored.length : 0).toBe(NAVIGATION_LIMIT);
    expect(await tracedOwnerOf(download(FILE_URL), owners, clock)).toBe(
      "unexplained",
    );
    expect(
      await tracedOwnerOf(
        download("https://site.example.org/0"),
        owners,
        clock,
      ),
    ).toBe("unexplained");
    expect(
      await tracedOwnerOf(
        download("https://site.example.org/1"),
        owners,
        clock,
      ),
    ).toBe("contained");
    expect(await tracedOwnerOf(download(PAYLOAD_URL), owners, clock)).toBe(
      "user",
    );
  });

  test("only web navigations of real tabs are recorded", async () => {
    const session: Record<string, unknown> = {};
    installStorage(session);
    await recordNavigation({
      tabId: USER_TAB,
      timeStamp: NOW,
      url: "chrome://newtab/",
    });
    await recordNavigation({
      tabId: -1,
      timeStamp: NOW,
      url: FILE_URL,
    });
    expect(session["browserRecentNavigations"]).toBe(undefined);
  });
});

describe("frames of tabs that close", () => {
  const CLOSING_TAB = 5;

  /**
   * Chrome lists the closing tab, then answers its frame lookup with null,
   * as it does for a tab id that is no longer valid. `stillOpen` says
   * whether the tab is in fact still there when asked again.
   */
  const installClosingTab = ({ stillOpen }: { stillOpen: boolean }): void => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: { id: "stella-extension" },
        storage: { session: { get: async () => ({}) } },
        tabs: {
          query: async () => [
            { id: USER_TAB },
            { id: CONTROLLED_TAB },
            { id: CLOSING_TAB },
          ],
          get: async (tabId: number) => {
            if (tabId === CLOSING_TAB && !stillOpen) {
              throw new Error(`No tab with id: ${String(tabId)}.`);
            }
            return { id: tabId };
          },
        },
        webNavigation: {
          getAllFrames: async ({ tabId }: { tabId: number }) => {
            if (tabId === CLOSING_TAB) {
              return null;
            }
            return [
              {
                frameId: 0,
                url:
                  tabId === CONTROLLED_TAB
                    ? "https://portal.example.com/"
                    : "https://drive.google.com/",
              },
            ];
          },
        },
      },
    });
  };

  const userBlob = download("blob:https://drive.google.com/7f3c");
  test("a tab closed while a download starts leaves the user's own download theirs", async () => {
    installClosingTab({ stillOpen: false });
    expect(await tracedOwnerOf(userBlob, owners, clock)).toBe("user");
  });

  test("an open tab whose frames Chrome cannot list still leaves the download unexplained", async () => {
    installClosingTab({ stillOpen: true });
    expect(await tracedOwnerOf(userBlob, owners, clock)).toBe("unexplained");
  });
});
