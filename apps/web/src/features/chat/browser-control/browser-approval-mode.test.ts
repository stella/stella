import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";
import { assertProperty } from "@stll/property-testing";

import { installUserScopedStorage } from "@/lib/account/install-user-scoped-storage";
import {
  releaseUserStorage,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";

import {
  beginBrowserCommand,
  BROWSER_APPROVAL_MODE,
  browserCommandSite,
  type BrowserObservedPage,
  createBrowserApprovalStore,
  decideBrowserAutoApproval,
  getBrowserApprovalMode,
  setBrowserApprovalMode,
  subscribeBrowserApproval,
} from "./browser-approval-mode";

const NO_SITES: ReadonlySet<string> = new Set();

const read = { action: "snapshot" } satisfies BrowserControlCommand;
const act = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: {
    context: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
    href: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
    name: "Submit",
    ref: "e:0:0.1",
    role: "button",
  },
} satisfies BrowserControlCommand;

const STORAGE_KEY = userStorageKey("stella.chat.browserApprovalMode");

const memoryStorage = (values: Record<string, string> = {}): Storage => {
  const entries = new Map(Object.entries(values));
  return {
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()].at(index) ?? null,
    get length() {
      return entries.size;
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const blockedStorage = (): Storage => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("browser approval mode", () => {
  test("subscribers follow the current account's snapshot and subsequent changes", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: storage },
    });
    const areas = () => ({ local: null, session: storage });
    const queryClient = new QueryClient();
    const unsubscribeOwner = installUserScopedStorage(queryClient, areas);
    const snapshots: ReturnType<typeof getBrowserApprovalMode>[] = [];
    let unsubscribe = () => {};
    try {
      queryClient.setQueryData(["session"], { user: { id: "account-a" } });
      setBrowserApprovalMode(BROWSER_APPROVAL_MODE.autoApproveReads);
      expect(getBrowserApprovalMode()).toBe(
        BROWSER_APPROVAL_MODE.autoApproveReads,
      );
      const finishEarlierCommand = beginBrowserCommand();
      unsubscribe = subscribeBrowserApproval(() => {
        snapshots.push(getBrowserApprovalMode());
      });
      releaseUserStorage(areas());
      expect(snapshots).toEqual([BROWSER_APPROVAL_MODE.askEveryTime]);
      storage.setItem(
        userStorageKey("stella.chat.browserApprovalMode", {
          kind: "user",
          userId: "account-b",
        }),
        JSON.stringify(BROWSER_APPROVAL_MODE.autoApproveReads),
      );
      queryClient.setQueryData(["session"], { user: { id: "account-b" } });
      expect(snapshots).toEqual([
        BROWSER_APPROVAL_MODE.askEveryTime,
        BROWSER_APPROVAL_MODE.autoApproveReads,
      ]);
      finishEarlierCommand(true);
      expect(snapshots).toHaveLength(2);
      setBrowserApprovalMode(BROWSER_APPROVAL_MODE.askEveryTime);
      expect(snapshots).toEqual([
        BROWSER_APPROVAL_MODE.askEveryTime,
        BROWSER_APPROVAL_MODE.autoApproveReads,
        BROWSER_APPROVAL_MODE.askEveryTime,
      ]);
      unsubscribe();
      setBrowserApprovalMode(BROWSER_APPROVAL_MODE.autoApproveReads);
      expect(snapshots).toHaveLength(3);
    } finally {
      unsubscribe();
      unsubscribeOwner();
      releaseUserStorage(areas());
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", previousWindow);
      }
    }
  });
  test("never auto-approves in the ask-every-time mode", () => {
    expect(
      decideBrowserAutoApproval({
        command: read,
        grantedOrigins: NO_SITES,
        lastCommandSucceeded: true,
        mode: BROWSER_APPROVAL_MODE.askEveryTime,
        observedPage: null,
      }).type !== "ask",
    ).toBe(false);
  });

  test("the reads mode covers page reads only", () => {
    const autoApproved = (command: BrowserControlCommand) =>
      decideBrowserAutoApproval({
        command,
        grantedOrigins: NO_SITES,
        lastCommandSucceeded: true,
        mode: BROWSER_APPROVAL_MODE.autoApproveReads,
        observedPage: null,
      }).type !== "ask";

    expect(autoApproved(read)).toBe(true);
    expect(autoApproved({ action: "go-back" })).toBe(false);
    expect(autoApproved({ action: "open", url: "https://example.com/" })).toBe(
      false,
    );
    expect(autoApproved(act)).toBe(false);
  });

  test("the reads mode asks after a browser command did not succeed", () => {
    expect(
      decideBrowserAutoApproval({
        command: read,
        grantedOrigins: NO_SITES,
        lastCommandSucceeded: false,
        mode: BROWSER_APPROVAL_MODE.autoApproveReads,
        observedPage: null,
      }).type !== "ask",
    ).toBe(false);
  });

  test("a stored legacy auto-approve-all mode falls back to asking", () => {
    const store = createBrowserApprovalStore(() =>
      memoryStorage({ [STORAGE_KEY]: JSON.stringify("auto-approve-all") }),
    );

    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);
  });

  test("restores a stored reads mode", () => {
    const storage = memoryStorage();
    createBrowserApprovalStore(() => storage).setMode(
      BROWSER_APPROVAL_MODE.autoApproveReads,
    );

    expect(createBrowserApprovalStore(() => storage).getMode()).toBe(
      BROWSER_APPROVAL_MODE.autoApproveReads,
    );
  });

  test("blocked storage falls back to asking and still keeps a chosen mode", () => {
    const store = createBrowserApprovalStore(blockedStorage);
    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);

    store.setMode(BROWSER_APPROVAL_MODE.autoApproveReads);
    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.autoApproveReads);
  });

  test("storage whose read throws falls back to asking", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
    const store = createBrowserApprovalStore(() => storage);

    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);
  });
});

describe("resetting browser approval", () => {
  test("a new pairing or handed-over tab asks again for every read", () => {
    const storage = memoryStorage();
    const store = createBrowserApprovalStore(() => storage);
    store.setMode(BROWSER_APPROVAL_MODE.autoApproveReads);
    store.beginCommand()(true);

    store.reset();

    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);
    expect(store.lastCommandSucceeded()).toBe(false);
    expect(createBrowserApprovalStore(() => storage).getMode()).toBe(
      BROWSER_APPROVAL_MODE.askEveryTime,
    );
  });

  test("a command that began before the reset cannot vouch for the new tab", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    const before = store.beginCommand();

    store.reset();
    before(true);

    expect(store.lastCommandSucceeded()).toBe(false);
  });
});

describe("last browser command outcome", () => {
  test("commands started before the owner refresh cannot vouch for it", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    const finishEarlierCommand = store.beginCommand();

    store.restoreOwner();
    finishEarlierCommand(true);
    expect(store.lastCommandSucceeded()).toBe(false);

    store.beginCommand()(true);
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("reads wait for a successful command in this tab session", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    expect(store.lastCommandSucceeded()).toBe(false);

    const finish = store.beginCommand();
    expect(store.lastCommandSucceeded()).toBe(false);
    finish(true);
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("a failed command blocks reads until a later command succeeds", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    store.beginCommand()(true);

    store.beginCommand()(false);
    expect(store.lastCommandSucceeded()).toBe(false);

    store.beginCommand()(true);
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("an older command finishing late cannot vouch for a newer failure", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    const older = store.beginCommand();
    const newer = store.beginCommand();

    newer(false);
    older(true);

    expect(store.lastCommandSucceeded()).toBe(false);
  });

  test("notifies subscribers when the outcome changes", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.beginCommand()(true);

    expect(notifications).toBe(2);
  });
});

describe("website approvals", () => {
  const GRANTED = "https://example.com";
  const granted: ReadonlySet<string> = new Set([GRANTED]);
  const FIELD = "e:0:0.4";
  const SECRET_FIELD = "e:0:0.5";

  /** URLs on and around the granted site; only the first two are on it. */
  const SITE_URLS: readonly string[] = [
    "https://example.com/search?q=contract",
    "https://EXAMPLE.com:443/",
    "https://www.example.com/",
    "https://evil-example.com/",
    "https://example.com.evil.test/",
    "http://example.com/",
    "https://example.com:8443/",
    "https://user:secret@example.com/",
    "https://other.test/",
  ];

  const observed = (url: string): BrowserObservedPage => ({
    revision: "revision-1",
    url,
    valueRefs: new Set([FIELD]),
  });

  const target = (ref: string) => ({
    context: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
    href: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
    name: "Field",
    ref,
    role: "textbox",
  });

  /** Every command, acting on the page at `url` or moving to `url`. */
  const commandsAt = (url: string, ref: string): BrowserControlCommand[] => {
    const page = { revision: "revision-1", url };
    return [
      { action: "snapshot" },
      { action: "go-back" },
      { action: "open", url },
      { action: "open", newTab: true, url },
      { action: "switch-tab", tabId: 3, url },
      { action: "click", page, target: target(ref) },
      { action: "fill", page, target: target(ref), value: "Smith v Jones" },
      { action: "select", page, target: target(ref), value: "CZ" },
      { action: "press-key", key: "Enter", page, target: target(ref) },
    ];
  };

  const expectedDecision = ({
    lastCommandSucceeded,
    readsMode,
    siteGrant,
  }: {
    lastCommandSucceeded: boolean;
    readsMode: boolean;
    siteGrant: boolean;
  }) => {
    if (!lastCommandSucceeded) {
      return "ask";
    }
    if (readsMode) {
      return "reads-mode";
    }
    return siteGrant ? "site-grant" : "ask";
  };

  // An independent oracle: HTTPS, no credentials, the exact origin.
  const isOnGrantedSite = (url: string) => {
    const parsed = URL.parse(url);
    return (
      parsed !== null &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.origin === GRANTED
    );
  };

  test("a command runs without asking exactly when the site it acts on or moves to is allowed", () => {
    assertProperty(
      "a command runs without asking exactly when the site it acts on or moves to is allowed",
      fc.property(
        fc.constantFrom(...SITE_URLS),
        fc.constantFrom(...SITE_URLS),
        fc.constantFrom(FIELD, SECRET_FIELD),
        fc.boolean(),
        fc.constantFrom(
          BROWSER_APPROVAL_MODE.askEveryTime,
          BROWSER_APPROVAL_MODE.autoApproveReads,
        ),
        (pageUrl, commandUrl, ref, lastCommandSucceeded, mode) => {
          const observedPage = observed(pageUrl);
          for (const command of commandsAt(commandUrl, ref)) {
            const decision = decideBrowserAutoApproval({
              command,
              grantedOrigins: granted,
              lastCommandSucceeded,
              mode,
              observedPage,
            });
            const navigates =
              command.action === "open" || command.action === "switch-tab";
            const onPage = "page" in command;
            const site = navigates
              ? isOnGrantedSite(commandUrl)
              : isOnGrantedSite(pageUrl) && (!onPage || commandUrl === pageUrl);
            const secretFill = command.action === "fill" && ref !== FIELD;
            const readsMode =
              mode === BROWSER_APPROVAL_MODE.autoApproveReads &&
              command.action === "snapshot";
            expect(decision.type).toBe(
              expectedDecision({
                lastCommandSucceeded,
                readsMode,
                siteGrant: site && !secretFill,
              }),
            );
            if (decision.type === "site-grant") {
              expect(decision.origin).toBe(GRANTED);
            }
          }
        },
      ),
    );
  });

  test("the page comes from the extension's report, never from the command", () => {
    // The model names the allowed site, but the tab last showed another one.
    for (const command of commandsAt("https://example.com/", FIELD)) {
      if (command.action === "open" || command.action === "switch-tab") {
        continue;
      }
      expect(
        decideBrowserAutoApproval({
          command,
          grantedOrigins: granted,
          lastCommandSucceeded: true,
          mode: BROWSER_APPROVAL_MODE.askEveryTime,
          observedPage: observed("https://other.test/"),
        }),
      ).toEqual({ type: "ask" });
    }
  });

  test("with no page reported, only a navigation to an allowed site skips asking", () => {
    for (const command of commandsAt("https://example.com/", FIELD)) {
      expect(
        decideBrowserAutoApproval({
          command,
          grantedOrigins: granted,
          lastCommandSucceeded: true,
          mode: BROWSER_APPROVAL_MODE.askEveryTime,
          observedPage: null,
        }).type,
      ).toBe(
        command.action === "open" || command.action === "switch-tab"
          ? "site-grant"
          : "ask",
      );
    }
  });

  test("an element command on an older read of the page asks", () => {
    expect(
      decideBrowserAutoApproval({
        command: {
          ...act,
          page: { revision: "revision-0", url: "https://example.com/" },
        },
        grantedOrigins: granted,
        lastCommandSucceeded: true,
        mode: BROWSER_APPROVAL_MODE.askEveryTime,
        observedPage: observed("https://example.com/"),
      }),
    ).toEqual({ type: "ask" });
  });

  test("the site a card names is the one its approval would cover", () => {
    expect(
      browserCommandSite({
        command: { action: "snapshot" },
        observedPage: observed("https://Example.com/a?b=c"),
      }),
    ).toBe(GRANTED);
    expect(
      browserCommandSite({
        command: { action: "open", url: "http://example.com/" },
        observedPage: null,
      }),
    ).toBeNull();
  });

  test("a website approval is kept for its result check, also across a reload", () => {
    const storage = memoryStorage();
    const store = createBrowserApprovalStore(() => storage);
    expect(store.recordSiteGrantApproval("call-1", granted)).toBe(true);

    const reloaded = createBrowserApprovalStore(() => storage);
    expect(reloaded.siteGrantApprovalFor("call-1")).toEqual(granted);
    expect(reloaded.siteGrantApprovalFor("call-2")).toBeNull();
  });

  test("an approval that cannot be kept is refused, so the card asks", () => {
    const store = createBrowserApprovalStore(blockedStorage);
    expect(store.recordSiteGrantApproval("call-1", granted)).toBe(false);
    expect(store.siteGrantApprovalFor("call-1")).toBeNull();
  });

  test("a new pairing forgets the page the extension reported", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    store.observePage(observed("https://example.com/"));
    store.reset();
    expect(store.getObservedPage()).toBeNull();
  });
});
