import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import { releaseToUser } from "./tab-containment";
import {
  adoptControlledTab,
  executeBrowserCommand,
  forgetControlledTab,
  replaceControlledTab,
} from "./tab-executor";

type TabChange = { status?: string; url?: string };
type FakeTab = { id: number; status: string; title?: string; url: string };
type Injection = {
  args?: [{ expectedTopOrigin?: string | null; kind: string }];
  /** The script itself, as Chrome would run it in each frame. */
  func?: (operation: unknown) => unknown;
  target: { documentIds?: string[]; frameIds?: number[]; tabId: number };
};
type InjectionResult = {
  documentId?: string;
  frameId: number;
  result: unknown;
}[];

const containsNull = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" && Object.values(value).some(containsNull));

const CONTROLLER_ID = "controller-1";
const CONTROLLER_TAB_ID = 1;
const CONTROLLED_TAB_ID = 2;
const PAGE_URL = "https://example.com/";
const WINDOW_ID = 1;

const frameSnapshot = (title: string, url = PAGE_URL) => ({
  elements: [],
  origin: new URL(url).origin,
  text: title,
  title,
  url,
});

const createFakeChrome = () => {
  const session: Record<string, unknown> = {
    browserControlledTab: {
      adopted: false,
      controllerId: CONTROLLER_ID,
      settled: { documentId: "document-top", url: PAGE_URL },
      snapshot: {
        documents: { "0": "document-top", "3": "document-frame" },
        revision: "revision-1",
        tabId: CONTROLLED_TAB_ID,
        url: PAGE_URL,
      },
      tabId: CONTROLLED_TAB_ID,
    },
    browserController: {
      controllerId: CONTROLLER_ID,
      origin: "https://my.stll.app",
    },
    browserStellaTabs: [
      {
        documentId: "document-stella",
        origin: "https://my.stll.app",
        tabId: CONTROLLER_TAB_ID,
      },
    ],
  };
  const tabs = new Map<number, FakeTab>([
    [
      CONTROLLER_TAB_ID,
      {
        id: CONTROLLER_TAB_ID,
        status: "complete",
        url: "https://my.stll.app/chat",
      },
    ],
    [
      CONTROLLED_TAB_ID,
      { id: CONTROLLED_TAB_ID, status: "complete", url: PAGE_URL },
    ],
  ]);
  const listeners = new Set<(tabId: number, change: TabChange) => void>();
  const log: string[] = [];
  const handlers: Record<
    string,
    (injection: Injection) => InjectionResult | Promise<InjectionResult>
  > = {};

  const emit = (tabId: number, change: TabChange) => {
    const tab = tabs.get(tabId);
    if (tab) {
      tabs.set(tabId, {
        ...tab,
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(change.url === undefined ? {} : { url: change.url }),
      });
    }
    for (const listener of listeners) {
      listener(tabId, change);
    }
  };

  const hooks = { afterCreate: (): void => undefined };

  // The tab in front of the one window, and the window with focus: the
  // stella tab, as when the user asks chat for something.
  const front: { activeTabId: number; focusedWindowId: number | null } = {
    activeTabId: CONTROLLER_TAB_ID,
    focusedWindowId: WINDOW_ID,
  };

  // What Chrome's navigation records say each tab's top frame shows.
  const probe = {
    failing: false,
    frames: new Map<number, { documentId: string; errorOccurred: boolean }>([
      [CONTROLLED_TAB_ID, { documentId: "document-top", errorOccurred: false }],
    ]),
  };

  const chrome = {
    webNavigation: {
      getFrame: async ({ tabId }: { frameId: number; tabId: number }) => {
        if (probe.failing) {
          throw new TypeError("No frame with id 0.");
        }
        const frame = probe.frames.get(tabId);
        const tab = tabs.get(tabId);
        return frame === undefined || tab === undefined
          ? null
          : { ...frame, frameId: 0, url: tab.url };
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async (options: {
        addRules?: { condition: { excludedTabIds?: number[] } }[];
      }) => {
        const excluded = new Set(
          (options.addRules ?? []).flatMap(
            (rule) => rule.condition.excludedTabIds ?? [],
          ),
        );
        log.push(`rules:except:${[...excluded].join(",")}`);
      },
    },
    scripting: {
      executeScript: async (injection: Injection) => {
        // Chrome drops an object property whose value is null from the
        // arguments it hands an injected function, so the page would read
        // undefined there. The fake refuses such an argument outright.
        if (containsNull(injection.args)) {
          throw new TypeError(
            "Chrome would drop a null property from these injected arguments.",
          );
        }
        const kind = injection.args?.[0]?.kind ?? "back";
        log.push(`inject:${kind}`);
        const handler = handlers[kind];
        if (!handler) {
          throw new TypeError(`No fake page handler for ${kind}`);
        }
        return await handler(injection);
      },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            Reflect.deleteProperty(session, key);
          }
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(session, items);
        },
      },
    },
    tabs: {
      create: async ({ url }: { url: string }) => {
        const tab = { id: 7, status: "complete", url };
        tabs.set(tab.id, tab);
        log.push(`create:${url}`);
        hooks.afterCreate();
        return { ...tab };
      },
      remove: async (tabId: number) => {
        tabs.delete(tabId);
        log.push(`remove:${tabId}`);
      },
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new TypeError(`No tab ${tabId}`);
        }
        return { ...tab, windowId: WINDOW_ID };
      },
      goBack: async () => undefined,
      query: async ({ active }: { active?: boolean } = {}) =>
        structuredClone(
          [...tabs.values()].filter(
            ({ id }) => active !== true || id === front.activeTabId,
          ),
        ),
      onUpdated: {
        addListener: (listener: (tabId: number, change: TabChange) => void) => {
          listeners.add(listener);
        },
        removeListener: (
          listener: (tabId: number, change: TabChange) => void,
        ) => {
          listeners.delete(listener);
        },
      },
      update: async (tabId: number, { url }: { url?: string }) => {
        front.activeTabId = tabId;
        if (url === undefined) {
          log.push(`activate:${tabId}`);
          const tab = tabs.get(tabId);
          return tab ? { ...tab } : undefined;
        }
        log.push(`update:${url}`);
        setTimeout(() => {
          emit(tabId, { status: "loading" });
          emit(tabId, { url });
          setTimeout(() => emit(tabId, { status: "complete" }), 20);
        }, 20);
        const tab = tabs.get(tabId);
        return tab ? { ...tab } : undefined;
      },
    },
    windows: {
      getLastFocused: async () => ({
        focused: front.focusedWindowId !== null,
        id: front.focusedWindowId ?? WINDOW_ID,
      }),
      update: async (windowId: number, { focused }: { focused: boolean }) => {
        log.push(`focus-window:${windowId}`);
        if (focused) {
          front.focusedWindowId = windowId;
        }
        return { focused, id: windowId };
      },
    },
  };

  return { chrome, emit, front, handlers, hooks, log, probe, session, tabs };
};

let fake = createFakeChrome();
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

const installFakeChrome = () => {
  fake = createFakeChrome();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: fake.chrome,
  });
  fake.handlers["locate"] = () => [
    { frameId: 0, result: { origin: "https://example.com", url: PAGE_URL } },
  ];
  return fake;
};

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

const userTab = (id: number, url: string): chrome.tabs.Tab => {
  const tab = {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: true,
    id,
    incognito: false,
    index: 0,
    lastAccessed: 0,
    pinned: false,
    selected: true,
    url,
    windowId: 1,
  };
  return tab;
};

const click = (ref = "e:0:1") =>
  ({
    action: "click",
    page: { revision: "revision-1", url: PAGE_URL },
    target: {
      context: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
      href: { type: BROWSER_CONTROL_TARGET_METADATA.absent },
      name: "Pay invoice",
      ref,
      role: "button",
    },
  }) satisfies BrowserControlCommand;

const OBSERVED_TAB = { revision: "revision-1", tabId: CONTROLLED_TAB_ID };

/** Records charges and refunds; `limit` charges succeed, then the budget is spent. */
const createBudget = (limit = Number.POSITIVE_INFINITY) => {
  const events: string[] = [];
  let charged = 0;
  return {
    budget: {
      async charge(): Promise<string | null> {
        if (charged >= limit) {
          events.push("exceeded");
          return "This chat turn has run its browser actions.";
        }
        charged += 1;
        events.push("charge");
        return null;
      },
      async refund(): Promise<void> {
        charged -= 1;
        events.push("refund");
      },
    },
    events,
  };
};

const run = async (
  command: BrowserControlCommand,
  {
    budget = createBudget().budget,
    observedTab = OBSERVED_TAB,
    signal = new AbortController().signal,
  }: {
    budget?: ReturnType<typeof createBudget>["budget"];
    observedTab?: typeof OBSERVED_TAB | null;
    signal?: AbortSignal;
  } = {},
) =>
  await executeBrowserCommand(CONTROLLER_ID, command, {
    budget,
    observedTab,
    signal,
  });

describe("outcome of a dispatched action", () => {
  test("is unknown when the page cannot be read after the click", async () => {
    const { handlers } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: { ok: true } }];
    handlers["snapshot"] = () => {
      throw new TypeError("Frame with ID 0 was removed.");
    };

    const result = await run(click());
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
      status: "error",
    });
    expect(JSON.stringify(result)).toContain("take a snapshot");
  });

  test("is unknown when the page gives no verdict for the click", async () => {
    const { handlers } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: undefined }];
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Home") },
    ];

    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when the tab closes after the click", async () => {
    const { handlers, tabs } = installFakeChrome();
    handlers["action"] = () => {
      tabs.delete(CONTROLLED_TAB_ID);
      return [{ frameId: 0, result: { ok: true } }];
    };

    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when the click lands outside the origin policy", async () => {
    const { emit, handlers } = installFakeChrome();
    handlers["action"] = () => {
      emit(CONTROLLED_TAB_ID, { url: "https://intranet.local/" });
      return [{ frameId: 0, result: { ok: true } }];
    };

    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when going back cannot be observed", async () => {
    const { handlers } = installFakeChrome();
    handlers["back"] = () => [{ frameId: 0, result: undefined }];
    handlers["snapshot"] = () => {
      throw new TypeError("The page is being unloaded.");
    };

    expect(await run({ action: "go-back" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("keeps a refusal from the page before acting as that refusal", async () => {
    const { handlers } = installFakeChrome();
    handlers["action"] = () => [
      {
        frameId: 0,
        result: {
          code: BROWSER_CONTROL_ERROR_CODE.sensitiveField,
          error: "Entered manually.",
          ok: false,
        },
      },
    ];

    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.sensitiveField,
    });
    // Nothing ran, so the same snapshot's refs still address the page.
    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.sensitiveField,
    });
  });

  test("retakes a snapshot that raced a late navigation", async () => {
    const { emit, handlers, log } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: { ok: true } }];
    let snapshots = 0;
    const nextUrl = "https://example.com/receipt";
    handlers["snapshot"] = () => {
      snapshots += 1;
      if (snapshots === 1) {
        // The form submits after the settle grace, while this read runs.
        emit(CONTROLLED_TAB_ID, { status: "loading" });
        setTimeout(() => {
          emit(CONTROLLED_TAB_ID, { url: nextUrl });
          emit(CONTROLLED_TAB_ID, { status: "complete" });
        }, 150);
        return [{ frameId: 0, result: frameSnapshot("Invoice") }];
      }
      return [{ frameId: 0, result: frameSnapshot("Receipt", nextUrl) }];
    };

    const result = await run(click());
    expect(result).toMatchObject({
      snapshot: { title: "Receipt", url: nextUrl },
      status: "success",
    });
    expect(log.filter((entry) => entry === "inject:snapshot")).toHaveLength(2);
  });
});

describe("frame policy for actions", () => {
  test("refuses a ref in a frame outside the policy without dispatching", async () => {
    const { handlers, log } = installFakeChrome();
    handlers["locate"] = () => [
      {
        frameId: 3,
        result: { origin: "https://192.168.1.1", url: "https://192.168.1.1/" },
      },
    ];
    handlers["action"] = () => [{ frameId: 3, result: { ok: true } }];

    expect(await run(click("e:3:0.1"))).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
    });
    expect(log).not.toContain("inject:action");
  });
});

describe("controlled tab confinement", () => {
  test("installs the tab rules before a new tab requests the approved URL", async () => {
    const { handlers, log } = installFakeChrome();
    await chrome.storage.session.remove("browserControlledTab");
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Home") },
    ];

    const result = await run(
      { action: "open", url: PAGE_URL },
      { observedTab: null },
    );
    expect(result).toMatchObject({ status: "success" });
    // Every tab but the new one stays the user's; the new one is confined.
    expect(log.slice(0, 3)).toEqual([
      "create:about:blank",
      `rules:except:${CONTROLLER_TAB_ID},${CONTROLLED_TAB_ID},-1`,
      `update:${PAGE_URL}`,
    ]);
  });

  test("a first open stopped before it navigates leaves no tab behind", async () => {
    const { handlers, hooks, log, session } = installFakeChrome();
    await chrome.storage.session.remove("browserControlledTab");
    const stop = new AbortController();
    // Stop lands while Chrome creates the tab.
    hooks.afterCreate = () => {
      stop.abort();
    };

    expect(
      await run(
        { action: "open", url: PAGE_URL },
        { observedTab: null, signal: stop.signal },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });
    expect(log).toContain("remove:7");
    expect(session["browserControlledTab"]).toBeUndefined();
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);

    // The next open starts over instead of being refused.
    hooks.afterCreate = () => undefined;
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Home") },
    ];
    expect(
      await run({ action: "open", url: PAGE_URL }, { observedTab: null }),
    ).toMatchObject({ status: "success" });
  });

  test("follows the controlled tab when Chrome swaps it for another", async () => {
    const { session } = installFakeChrome();

    expect(await replaceControlledTab(8, CONTROLLED_TAB_ID)).toBe(true);
    expect(session["browserControlledTab"]).toMatchObject({
      settled: { documentId: "document-top", url: PAGE_URL },
      snapshot: null,
      tabId: 8,
    });
    expect(await replaceControlledTab(9, 5)).toBe(false);
  });

  test("never adopts a stella tab or a stella page", async () => {
    const { log } = installFakeChrome();
    // Even if a stella tab now showed a public page, it stays stella's.
    expect(
      await adoptControlledTab(
        CONTROLLER_ID,
        userTab(CONTROLLER_TAB_ID, PAGE_URL),
      ),
    ).toEqual({ status: "unsupported-page" });
    expect(
      await adoptControlledTab(
        CONTROLLER_ID,
        userTab(5, "https://my.stll.app/matters"),
      ),
    ).toEqual({ status: "unsupported-page" });
    expect(log).toEqual([]);

    expect(
      await adoptControlledTab(CONTROLLER_ID, userTab(5, PAGE_URL)),
    ).toEqual({ status: "adopted", tabId: 5, url: PAGE_URL });
    expect(log).toEqual([
      `rules:except:${CONTROLLER_TAB_ID},${CONTROLLED_TAB_ID},-1`,
    ]);
  });
});

describe("chat's tabs", () => {
  const RESULTS_TAB_ID = 5;
  const RESULTS_URL = "https://example.com/results";
  const USER_TAB_ID = 9;

  /**
   * Chat controls tab 2; its page opened tab 5; tab 9 is the user's. Tabs in
   * `confined` are confined beside them but not chat's.
   */
  const installChatTabs = ({
    confined = [],
    opened = [RESULTS_TAB_ID],
  }: { confined?: number[]; opened?: number[] } = {}) => {
    const installed = installFakeChrome();
    installed.tabs.set(CONTROLLED_TAB_ID, {
      id: CONTROLLED_TAB_ID,
      status: "complete",
      title: "Invoice",
      url: PAGE_URL,
    });
    for (const tabId of [...opened, ...confined]) {
      installed.tabs.set(tabId, {
        id: tabId,
        status: "complete",
        title: "Results",
        url: RESULTS_URL,
      });
    }
    installed.tabs.set(USER_TAB_ID, {
      id: USER_TAB_ID,
      status: "complete",
      title: "Bank",
      url: PAGE_URL,
    });
    installed.session["browserContainedTabs"] = {
      adoptedTabIds: [],
      chatTabIds: opened,
      controlledTabId: CONTROLLED_TAB_ID,
      controlledUserNavigated: false,
      openedTabIds: [...opened, ...confined],
      userTabIds: [CONTROLLER_TAB_ID, USER_TAB_ID],
    };
    return installed;
  };

  const switchTo = (tabId: number, url = RESULTS_URL) =>
    ({ action: "switch-tab", tabId, url }) satisfies BrowserControlCommand;

  test("opens a page in a new tab, contained before it navigates", async () => {
    const { handlers, log, session } = installChatTabs();
    const newUrl = "https://example.org/news";
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("News", newUrl) },
    ];

    // A new tab leaves the controlled one as it is, so what chat saw there
    // does not matter.
    const result = await run(
      { action: "open", newTab: true, url: newUrl },
      { observedTab: { revision: "revision-0", tabId: CONTROLLED_TAB_ID } },
    );
    expect(result).toMatchObject({
      snapshot: { tabId: 7, title: "News" },
      status: "success",
    });
    // The active tab first, then the others newest first; by address only,
    // since Chrome's titles of other tabs skip the page's redaction.
    expect(result.status === "success" && result.snapshot.tabs).toEqual([
      { active: true, tabId: 7, url: newUrl },
      { active: false, tabId: CONTROLLED_TAB_ID, url: PAGE_URL },
      { active: false, tabId: RESULTS_TAB_ID, url: RESULTS_URL },
    ]);
    // Only the user's tabs are left out of the rules from before the new
    // tab requests anything.
    expect(log.slice(0, 3)).toEqual([
      "create:about:blank",
      `rules:except:${CONTROLLER_TAB_ID},${USER_TAB_ID},-1`,
      `update:${newUrl}`,
    ]);
    expect(session["browserContainedTabs"]).toEqual({
      adoptedTabIds: [],
      chatTabIds: [RESULTS_TAB_ID, CONTROLLED_TAB_ID],
      controlledTabId: 7,
      controlledUserNavigated: false,
      openedTabIds: [RESULTS_TAB_ID, CONTROLLED_TAB_ID],
      userTabIds: [CONTROLLER_TAB_ID, USER_TAB_ID],
    });
    expect(session["browserControlledTab"]).toMatchObject({
      adopted: false,
      tabId: 7,
    });
  });

  /** Calls `onWrite` right after the controlled tab is stored as `tabId`. */
  const afterControlledTabWrite = (
    installed: ReturnType<typeof installFakeChrome>,
    tabId: number,
    onWrite: () => Promise<void>,
  ) => {
    const { set } = installed.chrome.storage.session;
    installed.chrome.storage.session.set = async (
      items: Record<string, unknown>,
    ) => {
      await set(items);
      const written = items["browserControlledTab"];
      if (
        typeof written === "object" &&
        written !== null &&
        "tabId" in written &&
        written.tabId === tabId
      ) {
        await onWrite();
      }
    };
  };

  test("a new tab stopped after it became chat's hands control back", async () => {
    const installed = installChatTabs();
    const stop = new AbortController();
    afterControlledTabWrite(installed, 7, async () => {
      stop.abort();
    });

    expect(
      await run(
        { action: "open", newTab: true, url: PAGE_URL },
        { signal: stop.signal },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });
    expect(installed.log).toContain("remove:7");
    expect(installed.session["browserControlledTab"]).toMatchObject({
      snapshot: { revision: "revision-1" },
      tabId: CONTROLLED_TAB_ID,
    });
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
    });
  });

  test("a stopped new tab never hands control back to a tab the user took", async () => {
    const installed = installChatTabs();
    const stop = new AbortController();
    afterControlledTabWrite(installed, 7, async () => {
      // The user types an address into the former tab while the new one
      // is being prepared, and the command is stopped.
      await releaseToUser(CONTROLLED_TAB_ID);
      stop.abort();
    });

    expect(
      await run(
        { action: "open", newTab: true, url: PAGE_URL },
        { signal: stop.signal },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });
    expect(installed.log).toContain("remove:7");
    // No tab is controlled; the user's tab stays confined, not chat's.
    expect(installed.session["browserControlledTab"]).toBeUndefined();
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: null,
      openedTabIds: [RESULTS_TAB_ID, CONTROLLED_TAB_ID],
    });
  });

  test("a new tab Chrome refuses to navigate is closed and control handed back", async () => {
    const installed = installChatTabs();
    const { budget, events } = createBudget();
    const { update } = installed.chrome.tabs;
    installed.chrome.tabs.update = async (
      tabId: number,
      properties: { url?: string },
    ) => {
      if (tabId === 7 && properties.url !== undefined) {
        throw new TypeError("Cannot navigate the tab.");
      }
      return await update(tabId, properties);
    };

    expect(
      await run({ action: "open", newTab: true, url: PAGE_URL }, { budget }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.navigationFailed });
    expect(events).toEqual(["charge", "refund"]);
    expect(installed.log).toContain("remove:7");
    expect(installed.session["browserControlledTab"]).toMatchObject({
      tabId: CONTROLLED_TAB_ID,
    });
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
      openedTabIds: [RESULTS_TAB_ID],
    });
  });

  test("a tab that takes the last place while a new one is created wins it", async () => {
    // One place is left when the command checks.
    const opened = Array.from(
      { length: BROWSER_CONTROL_LIMITS.tabs - 2 },
      (_, index) => 20 + index,
    );
    const { hooks, log, session, tabs } = installChatTabs({ opened });
    const { budget, events } = createBudget();
    // A page in chat's tab opens one more while Chrome creates the new tab.
    hooks.afterCreate = () => {
      tabs.set(40, { id: 40, status: "complete", url: RESULTS_URL });
      session["browserContainedTabs"] = {
        adoptedTabIds: [],
        chatTabIds: [...opened, 40],
        controlledTabId: CONTROLLED_TAB_ID,
        controlledUserNavigated: false,
        openedTabIds: [...opened, 40],
        userTabIds: [CONTROLLER_TAB_ID, USER_TAB_ID],
      };
    };

    expect(
      await run({ action: "open", newTab: true, url: PAGE_URL }, { budget }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.tabLimitReached });
    expect(events).toEqual(["charge", "refund"]);
    expect(log).toContain("remove:7");
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
    expect(session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
      chatTabIds: [...opened, 40],
    });
    expect(session["browserControlledTab"]).toMatchObject({
      tabId: CONTROLLED_TAB_ID,
    });
  });

  test("lists other tabs by origin and path, and never the merely confined", async () => {
    const { handlers, tabs } = installChatTabs({ confined: [6] });
    const resultsWithQuery = `${RESULTS_URL}?session=secret-token#row-4`;
    tabs.set(RESULTS_TAB_ID, {
      id: RESULTS_TAB_ID,
      status: "complete",
      url: resultsWithQuery,
    });
    const pageWithQuery = `${PAGE_URL}invoice?id=42`;
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Invoice", pageWithQuery) },
    ];

    const result = await run({ action: "snapshot" });
    // The page read keeps its full address; the list does not.
    expect(result).toMatchObject({ snapshot: { url: pageWithQuery } });
    expect(result.status === "success" && result.snapshot.tabs).toEqual([
      {
        active: true,
        tabId: CONTROLLED_TAB_ID,
        url: `${PAGE_URL}invoice`,
      },
      { active: false, tabId: RESULTS_TAB_ID, url: RESULTS_URL },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");

    // The listed address is enough to switch: the origin is what counts.
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Results", resultsWithQuery) },
    ];
    expect(await run(switchTo(RESULTS_TAB_ID))).toMatchObject({
      snapshot: { tabId: RESULTS_TAB_ID },
      status: "success",
    });
    // A tab only confined beside chat's (say one an unknown tab opened) is
    // never chat's to switch to.
    expect(await run(switchTo(6))).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabChanged,
    });
  });

  test("switching back to a tab the user handed over keeps it the user's", async () => {
    const { handlers, session, tabs } = installChatTabs({ opened: [] });
    const handedOver = 12;
    tabs.set(handedOver, { id: handedOver, status: "complete", url: PAGE_URL });
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Invoice") },
    ];
    expect(
      await adoptControlledTab(CONTROLLER_ID, userTab(handedOver, PAGE_URL)),
    ).toMatchObject({ status: "adopted" });
    expect(
      await run(
        { action: "open", newTab: true, url: RESULTS_URL },
        { observedTab: null },
      ),
    ).toMatchObject({ status: "success" });

    expect(
      await run(switchTo(handedOver, PAGE_URL), { observedTab: null }),
    ).toMatchObject({ snapshot: { tabId: handedOver }, status: "success" });
    expect(session["browserControlledTab"]).toMatchObject({
      adopted: true,
      tabId: handedOver,
    });
    // A web client that saw no tab still may not navigate the user's page.
    expect(
      await run({ action: "open", url: RESULTS_URL }, { observedTab: null }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.tabChanged });
  });

  test("refuses a new tab once chat has the most tabs it may keep", async () => {
    const opened = Array.from(
      { length: BROWSER_CONTROL_LIMITS.tabs - 1 },
      (_, index) => 20 + index,
    );
    const { log } = installChatTabs({ opened });
    const { budget, events } = createBudget();

    const result = await run(
      { action: "open", newTab: true, url: PAGE_URL },
      { budget },
    );
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabLimitReached,
    });
    expect(JSON.stringify(result)).toContain("switch-tab");
    expect(log).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a new tab stopped before it navigates hands control back", async () => {
    const { hooks, log, session } = installChatTabs();
    const stop = new AbortController();
    hooks.afterCreate = () => {
      stop.abort();
    };

    expect(
      await run(
        { action: "open", newTab: true, url: PAGE_URL },
        { signal: stop.signal },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });
    expect(log).toContain("remove:7");
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
    expect(session["browserControlledTab"]).toMatchObject({
      snapshot: { revision: "revision-1" },
      tabId: CONTROLLED_TAB_ID,
    });
    expect(session["browserContainedTabs"]).toEqual({
      adoptedTabIds: [],
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
      controlledUserNavigated: false,
      openedTabIds: [RESULTS_TAB_ID],
      userTabIds: [CONTROLLER_TAB_ID, USER_TAB_ID],
    });
  });

  test("switches to a tab chat's page opened and reads it", async () => {
    const { handlers, log, session, tabs } = installChatTabs({
      opened: [RESULTS_TAB_ID, 6],
    });
    // A tab showing a page chat may not operate is not offered.
    tabs.set(6, {
      id: 6,
      status: "complete",
      url: "chrome-error://chromewebdata/",
    });
    handlers["snapshot"] = ({ target }) => [
      {
        documentId: "document-results",
        frameId: 0,
        result:
          target.tabId === RESULTS_TAB_ID
            ? frameSnapshot("Results", RESULTS_URL)
            : frameSnapshot("Invoice"),
      },
    ];
    const { budget, events } = createBudget();

    // The web client last saw another tab; switching is what changes it.
    const result = await run(switchTo(RESULTS_TAB_ID), {
      budget,
      observedTab: { revision: "revision-0", tabId: 99 },
    });
    expect(result).toMatchObject({
      snapshot: { tabId: RESULTS_TAB_ID },
      status: "success",
    });
    expect(result.status === "success" && result.snapshot.tabs).toEqual([
      { active: true, tabId: RESULTS_TAB_ID, url: RESULTS_URL },
      { active: false, tabId: CONTROLLED_TAB_ID, url: PAGE_URL },
    ]);
    expect(events).toEqual(["charge"]);
    expect(log).toContain(`activate:${RESULTS_TAB_ID}`);
    expect(session["browserContainedTabs"]).toMatchObject({
      controlledTabId: RESULTS_TAB_ID,
      openedTabIds: [6, CONTROLLED_TAB_ID],
    });
    expect(session["browserControlledTab"]).toMatchObject({
      adopted: false,
      settled: { documentId: "document-results", url: RESULTS_URL },
      tabId: RESULTS_TAB_ID,
    });

    // And back again, to the tab chat controlled before.
    expect(await run(switchTo(CONTROLLED_TAB_ID, PAGE_URL))).toMatchObject({
      snapshot: { tabId: CONTROLLED_TAB_ID },
      status: "success",
    });
  });

  test("never switches to the user's tab, a stella tab or an unknown tab", async () => {
    const { log, session, tabs } = installChatTabs();
    tabs.set(11, { id: 11, status: "complete", url: PAGE_URL });
    const { budget, events } = createBudget();

    for (const tabId of [USER_TAB_ID, CONTROLLER_TAB_ID, 11]) {
      expect(await run(switchTo(tabId, PAGE_URL), { budget })).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.tabChanged,
      });
    }
    // Even a stella tab that somehow counted as chat's is refused.
    session["browserContainedTabs"] = {
      adoptedTabIds: [],
      chatTabIds: [CONTROLLER_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
      controlledUserNavigated: false,
      openedTabIds: [CONTROLLER_TAB_ID],
      userTabIds: [USER_TAB_ID],
    };
    expect(
      await run(switchTo(CONTROLLER_TAB_ID, "https://my.stll.app/chat"), {
        budget,
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.tabChanged });

    expect(events).toEqual([]);
    expect(log).toEqual([]);
    expect(session["browserControlledTab"]).toMatchObject({
      tabId: CONTROLLED_TAB_ID,
    });
  });

  test("a stop once control has moved asks for a read instead of reading", async () => {
    const installed = installChatTabs();
    const stop = new AbortController();
    afterControlledTabWrite(installed, RESULTS_TAB_ID, async () => {
      stop.abort();
    });

    expect(
      await run(switchTo(RESULTS_TAB_ID), { signal: stop.signal }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown });
    expect(installed.log).not.toContain("inject:snapshot");
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      controlledTabId: RESULTS_TAB_ID,
    });
  });

  test("a tab Chrome cannot bring to the front is not switched to", async () => {
    const installed = installChatTabs();
    const { budget, events } = createBudget();
    installed.chrome.tabs.update = async () => {
      throw new TypeError("No tab with id 5.");
    };

    expect(await run(switchTo(RESULTS_TAB_ID), { budget })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
    });
    expect(events).toEqual(["charge", "refund"]);
    expect(installed.log).not.toContain("inject:snapshot");
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
    });
    expect(installed.session["browserControlledTab"]).toMatchObject({
      snapshot: { revision: "revision-1" },
      tabId: CONTROLLED_TAB_ID,
    });
  });

  test("switching shows the tab in a focused window, or switches nothing", async () => {
    const installed = installChatTabs();
    installed.front.focusedWindowId = null;
    installed.handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Results", RESULTS_URL) },
    ];
    expect(await run(switchTo(RESULTS_TAB_ID))).toMatchObject({
      status: "success",
    });
    expect(installed.log.slice(0, 2)).toEqual([
      `activate:${RESULTS_TAB_ID}`,
      `focus-window:${WINDOW_ID}`,
    ]);

    // A window Chrome cannot focus fails the switch before anything moves.
    const failing = installChatTabs();
    const { budget, events } = createBudget();
    failing.chrome.windows.update = async () => {
      throw new TypeError("No window with id 1.");
    };
    expect(await run(switchTo(RESULTS_TAB_ID), { budget })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
    });
    expect(events).toEqual(["charge", "refund"]);
    expect(failing.session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
    });
  });

  /** Stops the command once the switch has focused the tab's window. */
  const stopOnceShown = (installed: ReturnType<typeof installChatTabs>) => {
    const stop = new AbortController();
    const { update } = installed.chrome.windows;
    installed.chrome.windows.update = async (
      windowId: number,
      properties: { focused: boolean },
    ) => {
      const updated = await update(windowId, properties);
      stop.abort();
      return updated;
    };
    return stop.signal;
  };

  test("a stop after the tab was shown puts the user's tab back in front", async () => {
    const installed = installChatTabs();
    const { budget, events } = createBudget();
    const signal = stopOnceShown(installed);

    expect(
      await run(switchTo(RESULTS_TAB_ID), { budget, signal }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });
    expect(installed.front.activeTabId).toBe(CONTROLLER_TAB_ID);
    expect(installed.log).toEqual([
      `activate:${RESULTS_TAB_ID}`,
      `focus-window:${WINDOW_ID}`,
      `activate:${CONTROLLER_TAB_ID}`,
      `focus-window:${WINDOW_ID}`,
    ]);
    expect(events).toEqual(["charge", "refund"]);
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
    });
  });

  test("a stop whose tab cannot be put back has an unknown outcome", async () => {
    const installed = installChatTabs();
    const signal = stopOnceShown(installed);
    const { update } = installed.chrome.tabs;
    installed.chrome.tabs.update = async (
      tabId: number,
      properties: { url?: string },
    ) => {
      if (tabId === CONTROLLER_TAB_ID) {
        throw new TypeError("No tab with id 1.");
      }
      return await update(tabId, properties);
    };

    expect(await run(switchTo(RESULTS_TAB_ID), { signal })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
    });
  });

  test("the injected script refuses another top origin before reading the page", async () => {
    const { handlers } = installChatTabs();
    const injected: {
      func: ((operation: unknown) => unknown) | undefined;
      operation: unknown;
    } = { func: undefined, operation: undefined };
    handlers["snapshot"] = (injection) => {
      injected.func = injection.func;
      injected.operation = injection.args?.[0];
      return [];
    };
    await run(switchTo(RESULTS_TAB_ID));
    const { func, operation } = injected;
    if (func === undefined) {
      throw new TypeError("No script was injected.");
    }
    expect(operation).toMatchObject({
      expectedTopOrigin: "https://example.com",
      kind: "snapshot",
    });

    // A document that fails the test on any read: the script must decide
    // before it looks at the page at all.
    const unreadDocument = new Proxy(
      {},
      {
        get: () => {
          throw new TypeError("The document was read.");
        },
      },
    );
    const frameWindow = (
      origin: string,
      ancestorOrigins: readonly string[],
      isTop: boolean,
    ) => {
      const frame: Record<string, unknown> = {
        location: {
          ancestorOrigins: {
            item: (index: number) => ancestorOrigins[index] ?? null,
            length: ancestorOrigins.length,
          },
        },
        origin,
      };
      frame["top"] = isTop ? frame : {};
      return frame;
    };
    const ISOLATED_WORLD_KEYS = [
      "stellaSecretValues",
      "stellaSensitiveFields",
      "stellaSecretWatch",
    ];
    const runInFrame = (frame: Record<string, unknown>) => {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: frame,
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: unreadDocument,
      });
      try {
        return func(operation);
      } finally {
        for (const key of ["window", "document", ...ISOLATED_WORLD_KEYS]) {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    };
    const refused = { refused: "top-origin" };

    // The top frame now shows another site.
    expect(runInFrame(frameWindow("https://other.example", [], true))).toEqual(
      refused,
    );
    // A frame on the approved origin inside another site's page.
    expect(
      runInFrame(
        frameWindow("https://example.com", ["https://other.example"], false),
      ),
    ).toEqual(refused);
    // A frame the browser does not tell its top origin.
    expect(runInFrame(frameWindow("https://example.com", [], false))).toEqual(
      refused,
    );
    // On the approved origin the script goes on to read the page.
    expect(() =>
      runInFrame(frameWindow("https://example.com", [], true)),
    ).toThrow("The document was read.");
  });

  test("a page chat opens over the user's navigation makes the tab chat's again", async () => {
    const installed = installChatTabs();
    // The user typed an address into the controlled tab earlier.
    installed.session["browserContainedTabs"] = {
      adoptedTabIds: [],
      chatTabIds: [RESULTS_TAB_ID],
      controlledTabId: CONTROLLED_TAB_ID,
      controlledUserNavigated: true,
      openedTabIds: [RESULTS_TAB_ID],
      userTabIds: [CONTROLLER_TAB_ID, USER_TAB_ID],
    };
    installed.handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Invoice") },
    ];

    expect(await run({ action: "open", url: PAGE_URL })).toMatchObject({
      status: "success",
    });
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
      controlledUserNavigated: false,
    });

    // Moving on to a new tab keeps the one chat just operated as chat's.
    expect(
      await run(
        { action: "open", newTab: true, url: RESULTS_URL },
        { observedTab: null },
      ),
    ).toMatchObject({ status: "success" });
    expect(installed.session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [RESULTS_TAB_ID, CONTROLLED_TAB_ID],
      controlledTabId: 7,
    });
  });

  test("ownership, not a listing, decides which tab chat may switch to", async () => {
    const { handlers, tabs } = installChatTabs({ opened: [RESULTS_TAB_ID, 6] });
    // Tab 6 was on an error page when chat last read, so no list showed it;
    // it is chat's all the same.
    tabs.set(6, { id: 6, status: "complete", url: RESULTS_URL });
    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Results", RESULTS_URL) },
    ];
    expect(await run(switchTo(6))).toMatchObject({
      snapshot: { tabId: 6 },
      status: "success",
    });

    // The refusal names the rule chat is held to.
    const refusal = JSON.stringify(await run(switchTo(USER_TAB_ID, PAGE_URL)));
    expect(refusal).toContain(BROWSER_CONTROL_ERROR_CODE.tabChanged);
    expect(refusal).toContain("controlled before");
    expect(refusal).not.toContain("listed");
  });

  test("refuses a tab that left the origin the user approved", async () => {
    const { log, session, tabs } = installChatTabs();
    const { budget, events } = createBudget();
    tabs.set(RESULTS_TAB_ID, {
      id: RESULTS_TAB_ID,
      status: "complete",
      url: "https://other.example/",
    });

    expect(await run(switchTo(RESULTS_TAB_ID), { budget })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabChanged,
    });
    tabs.set(RESULTS_TAB_ID, {
      id: RESULTS_TAB_ID,
      status: "complete",
      url: "http://example.com/results",
    });
    expect(await run(switchTo(RESULTS_TAB_ID), { budget })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
    });
    expect(events).toEqual([]);
    expect(log).toEqual([]);
    expect(session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED_TAB_ID,
    });
  });

  test("does not return a page that left the approved origin while switching", async () => {
    const { handlers } = installChatTabs();
    handlers["snapshot"] = () => [
      {
        frameId: 0,
        result: frameSnapshot("Elsewhere", "https://other.example/"),
      },
    ];

    const result = await run(switchTo(RESULTS_TAB_ID));
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabChanged,
    });
    expect(JSON.stringify(result)).toContain("was not read");
  });

  test("the page refuses to be read once it left the approved origin", async () => {
    const { handlers, session } = installChatTabs();
    const seenOrigins: (string | null | undefined)[] = [];
    // The tab moved to another site after the checks: the page, as the
    // injected script does, refuses when its top origin is not the one
    // the worker expects.
    handlers["snapshot"] = ({ args }) => {
      const expected = args?.[0].expectedTopOrigin;
      seenOrigins.push(expected);
      return [
        {
          frameId: 0,
          result:
            typeof expected === "string" && expected !== "https://other.example"
              ? { refused: "top-origin" }
              : frameSnapshot("Elsewhere", "https://other.example/"),
        },
      ];
    };

    const result = await run(switchTo(RESULTS_TAB_ID));
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabChanged,
    });
    expect(JSON.stringify(result)).toContain("was not read");
    expect(seenOrigins).toEqual(["https://example.com"]);
    // Nothing the refused read saw is kept as what chat last read.
    expect(session["browserControlledTab"]).toMatchObject({
      settled: null,
      snapshot: null,
      tabId: RESULTS_TAB_ID,
    });

    // A plain snapshot reads any page, as before.
    handlers["snapshot"] = ({ args }) => {
      seenOrigins.push(args?.[0].expectedTopOrigin);
      return [{ frameId: 0, result: frameSnapshot("Results", RESULTS_URL) }];
    };
    expect(await run({ action: "snapshot" })).toMatchObject({
      status: "success",
    });
    // No origin is sent at all: Chrome would turn a null into undefined.
    expect(seenOrigins.at(-1)).toBeUndefined();
  });

  test("after the controlled tab closes, chat's other tabs stay reachable", async () => {
    const { handlers, tabs } = installChatTabs();
    tabs.delete(CONTROLLED_TAB_ID);
    expect(await forgetControlledTab(CONTROLLED_TAB_ID)).toBe(true);

    const read = await run({ action: "snapshot" }, { observedTab: null });
    expect(read).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.noControlledTab,
    });
    expect(JSON.stringify(read)).toContain("switch");

    handlers["snapshot"] = () => [
      { frameId: 0, result: frameSnapshot("Results", RESULTS_URL) },
    ];
    expect(
      await run(switchTo(RESULTS_TAB_ID), { observedTab: null }),
    ).toMatchObject({
      snapshot: {
        tabId: RESULTS_TAB_ID,
        tabs: [{ active: true, tabId: RESULTS_TAB_ID }],
      },
      status: "success",
    });
  });
});

describe("stopping a command", () => {
  test("a command stopped before it starts never reaches the page", async () => {
    const { handlers, log } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: { ok: true } }];
    const stop = new AbortController();
    stop.abort();

    expect(await run(click(), { signal: stop.signal })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.cancelled,
    });
    expect(log).toEqual([]);
  });

  test("a stop after the click reports an unknown outcome at once", async () => {
    const { emit, handlers } = installFakeChrome();
    handlers["action"] = () => {
      // The click starts a navigation that never finishes.
      emit(CONTROLLED_TAB_ID, { status: "loading" });
      return [{ frameId: 0, result: { ok: true } }];
    };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();

    const result = await run(click(), { signal: stop.signal });
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(JSON.stringify(result)).toContain("stopped");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("command identity", () => {
  test("acts in the exact document the snapshot read", async () => {
    const { handlers } = installFakeChrome();
    const targets: Injection["target"][] = [];
    handlers["locate"] = (injection) => {
      targets.push(injection.target);
      return [
        {
          frameId: 3,
          result: { origin: "https://example.com", url: PAGE_URL },
        },
      ];
    };
    handlers["action"] = (injection) => {
      targets.push(injection.target);
      return [{ frameId: 3, result: { ok: true } }];
    };
    handlers["snapshot"] = () => [
      {
        documentId: "document-next",
        frameId: 0,
        result: frameSnapshot("Paid"),
      },
    ];

    expect(await run(click("e:3:0.1"))).toMatchObject({ status: "success" });
    expect(targets).toEqual([
      { documentIds: ["document-frame"], tabId: CONTROLLED_TAB_ID },
      { documentIds: ["document-frame"], tabId: CONTROLLED_TAB_ID },
    ]);
  });

  test("refuses a ref whose frame loaded another document", async () => {
    const { handlers, log } = installFakeChrome();
    handlers["locate"] = () => {
      throw new TypeError("No document with id document-frame.");
    };
    handlers["action"] = () => [{ frameId: 3, result: { ok: true } }];

    expect(await run(click("e:3:0.1"))).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
    });
    expect(log).not.toContain("inject:action");
  });

  test("refuses a ref into a frame the snapshot never read", async () => {
    const { log } = installFakeChrome();

    expect(await run(click("e:5:0.1"))).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
    });
    expect(log).toEqual([]);
  });

  test("refuses to act after the user handed chat another tab", async () => {
    const { log } = installFakeChrome();

    for (const command of [
      click(),
      { action: "go-back" },
      { action: "open", url: PAGE_URL },
    ] satisfies BrowserControlCommand[]) {
      expect(
        await run(command, { observedTab: { ...OBSERVED_TAB, tabId: 99 } }),
      ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.tabChanged });
    }
    // Navigations only locate the live page before refusing.
    expect(log.filter((entry) => entry !== "inject:locate")).toEqual([]);
  });

  test("a dispatched action retires the refs of the snapshot it used", async () => {
    const { handlers, session } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: undefined }];

    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(session["browserControlledTab"]).toMatchObject({ snapshot: null });
    expect(await run(click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
    });
  });
});

describe("action budget", () => {
  test("a command refused before it acts costs nothing", async () => {
    installFakeChrome();
    const { budget, events } = createBudget();

    expect(
      await run(click(), {
        budget,
        observedTab: { ...OBSERVED_TAB, tabId: 99 },
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.tabChanged });
    expect(
      await run(
        { ...click(), page: { revision: "revision-0", url: PAGE_URL } },
        { budget },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
    expect(events).toEqual([]);
  });

  test("a page that refuses the action gets its charge back", async () => {
    const { handlers } = installFakeChrome();
    handlers["action"] = () => [
      {
        frameId: 0,
        result: {
          code: BROWSER_CONTROL_ERROR_CODE.sensitiveField,
          error: "Entered manually.",
          ok: false,
        },
      },
    ];
    const { budget, events } = createBudget();

    await run(click(), { budget });
    expect(events).toEqual(["charge", "refund"]);
  });

  test("a spent budget stops the action before the page sees it", async () => {
    const { handlers, log } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: { ok: true } }];

    expect(
      await run(click(), { budget: createBudget(0).budget }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.budgetExceeded });
    expect(log).not.toContain("inject:action");
  });
});

describe("navigation after the user moved the page", () => {
  test("going back is refused once the page is no longer the one chat saw", async () => {
    const { emit, handlers, log, probe, session } = installFakeChrome();
    probe.frames.set(CONTROLLED_TAB_ID, {
      documentId: "document-home",
      errorOccurred: false,
    });
    handlers["snapshot"] = () => [
      {
        documentId: "document-home",
        frameId: 0,
        result: frameSnapshot("Home"),
      },
    ];
    handlers["locate"] = () => [
      {
        documentId: "document-home",
        frameId: 0,
        result: { origin: "https://example.com", url: PAGE_URL },
      },
    ];
    const read = await run({ action: "snapshot" });
    if (read.status !== "success") {
      throw new TypeError("The fake snapshot failed");
    }
    expect(session["browserControlledTab"]).toMatchObject({
      settled: { documentId: "document-home", url: PAGE_URL },
    });
    const observedTab = {
      revision: read.snapshot.revision,
      tabId: CONTROLLED_TAB_ID,
    };

    // The user follows a link in the controlled tab by hand.
    emit(CONTROLLED_TAB_ID, { url: "https://example.com/elsewhere" });
    probe.frames.set(CONTROLLED_TAB_ID, {
      documentId: "document-elsewhere",
      errorOccurred: false,
    });

    for (const command of [
      { action: "go-back" },
      { action: "open", url: PAGE_URL },
    ] satisfies BrowserControlCommand[]) {
      expect(await run(command, { observedTab })).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
      });
    }
    expect(log).not.toContain("inject:back");
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
  });
});

describe("what chat last saw", () => {
  const home = (documentId: string) => [
    { documentId, frameId: 0, result: frameSnapshot("Home") },
  ];

  test("a stopped read after the user moved on does not count as seeing the new page", async () => {
    const { emit, handlers, probe } = installFakeChrome();
    handlers["snapshot"] = () => home("document-home");
    const read = await run({ action: "snapshot" });
    if (read.status !== "success") {
      throw new TypeError("The fake snapshot failed");
    }
    const observedTab = {
      revision: read.snapshot.revision,
      tabId: CONTROLLED_TAB_ID,
    };
    emit(CONTROLLED_TAB_ID, { url: "https://example.com/elsewhere" });
    probe.frames.set(CONTROLLED_TAB_ID, {
      documentId: "document-elsewhere",
      errorOccurred: false,
    });
    const stop = new AbortController();
    stop.abort();
    expect(
      await run({ action: "snapshot" }, { observedTab, signal: stop.signal }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.cancelled });

    expect(
      await run({ action: "open", url: PAGE_URL }, { observedTab }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
  });

  test("a read records the document it read, not one that replaced it meanwhile", async () => {
    const { emit, handlers, log, probe } = installFakeChrome();
    handlers["snapshot"] = () => {
      // The user navigates while the read is being stored.
      emit(CONTROLLED_TAB_ID, { url: "https://example.com/elsewhere" });
      probe.frames.set(CONTROLLED_TAB_ID, {
        documentId: "document-elsewhere",
        errorOccurred: false,
      });
      return home("document-home");
    };
    const read = await run({ action: "snapshot" });
    if (read.status !== "success") {
      throw new TypeError("The fake snapshot failed");
    }

    expect(
      await run(
        { action: "open", url: PAGE_URL },
        {
          observedTab: {
            revision: read.snapshot.revision,
            tabId: CONTROLLED_TAB_ID,
          },
        },
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
  });
});

describe("navigating when the page's identity is unclear", () => {
  const observedTab = { revision: "revision-1", tabId: CONTROLLED_TAB_ID };

  test("a failed probe while the user moved on refuses the old command", async () => {
    const { emit, log, probe } = installFakeChrome();
    emit(CONTROLLED_TAB_ID, { url: "https://example.com/elsewhere" });
    probe.failing = true;

    for (const command of [
      { action: "go-back" },
      { action: "open", url: PAGE_URL },
    ] satisfies BrowserControlCommand[]) {
      expect(await run(command, { observedTab })).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
      });
    }
    expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
  });

  test("an error page, or what looks like one, is no way around it", async () => {
    // Chrome shows its error page, or the user moved on to a readable page
    // whose later navigation failed while scripts are refused for another
    // reason: nothing tells these apart, so both are refused.
    for (const reason of [
      "Frame with ID 0 is showing error page",
      "Cannot access contents of the page.",
    ]) {
      const { emit, handlers, log, probe } = installFakeChrome();
      emit(CONTROLLED_TAB_ID, { url: "https://example.com/elsewhere" });
      probe.frames.set(CONTROLLED_TAB_ID, {
        documentId: "document-elsewhere",
        errorOccurred: true,
      });
      handlers["locate"] = () => {
        throw new TypeError(reason);
      };

      const refused = await run(
        { action: "open", url: PAGE_URL },
        { observedTab },
      );
      expect(refused).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
      });
      // The model is told how the user gets the tab going again.
      expect(JSON.stringify(refused)).toContain("ask the user");
      expect(log.filter((entry) => entry.startsWith("update:"))).toEqual([]);
    }
  });
});
