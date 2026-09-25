import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import { adoptControlledTab, executeBrowserCommand } from "./tab-executor";

type TabChange = { status?: string; url?: string };
type FakeTab = { id: number; status: string; url: string };
type Injection = {
  args?: [{ kind: string }];
  target: { frameIds?: number[]; tabId: number };
};
type InjectionResult = { frameId: number; result: unknown }[];

const CONTROLLER_ID = "controller-1";
const CONTROLLER_TAB_ID = 1;
const CONTROLLED_TAB_ID = 2;
const PAGE_URL = "https://example.com/";

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
      controllerId: CONTROLLER_ID,
      revision: "revision-1",
      tabId: CONTROLLED_TAB_ID,
      url: PAGE_URL,
    },
    browserController: {
      controllerId: CONTROLLER_ID,
      origin: "https://my.stll.app",
      tabId: CONTROLLER_TAB_ID,
    },
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

  const chrome = {
    declarativeNetRequest: {
      updateSessionRules: async (options: {
        addRules?: { condition: { tabIds?: number[] } }[];
      }) => {
        const tabIds = new Set(
          (options.addRules ?? []).flatMap(
            (rule) => rule.condition.tabIds ?? [],
          ),
        );
        log.push(`rules:${[...tabIds].join(",")}`);
      },
    },
    scripting: {
      executeScript: async (injection: Injection) => {
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
        return { ...tab };
      },
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          throw new TypeError(`No tab ${tabId}`);
        }
        return { ...tab };
      },
      goBack: async () => undefined,
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
      update: async (tabId: number, { url }: { url: string }) => {
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
  };

  return { chrome, emit, handlers, log, tabs };
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

const userTab = (id: number, url: string): chrome.tabs.Tab => ({
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
  // oxlint-disable-next-line typescript/no-deprecated -- chrome.tabs.Tab still requires the field
  selected: true,
  url,
  windowId: 1,
});

const click = (ref = "e:0:1") =>
  ({
    action: "click",
    page: { revision: "revision-1", url: PAGE_URL },
    target: { name: "Pay invoice", ref, role: "button" },
  }) satisfies BrowserControlCommand;

describe("outcome of a dispatched action", () => {
  test("is unknown when the page cannot be read after the click", async () => {
    const { handlers } = installFakeChrome();
    handlers["action"] = () => [{ frameId: 0, result: { ok: true } }];
    handlers["snapshot"] = () => {
      throw new TypeError("Frame with ID 0 was removed.");
    };

    const result = await executeBrowserCommand(CONTROLLER_ID, click());
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

    expect(await executeBrowserCommand(CONTROLLER_ID, click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when the tab closes after the click", async () => {
    const { handlers, tabs } = installFakeChrome();
    handlers["action"] = () => {
      tabs.delete(CONTROLLED_TAB_ID);
      return [{ frameId: 0, result: { ok: true } }];
    };

    expect(await executeBrowserCommand(CONTROLLER_ID, click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when the click lands outside the origin policy", async () => {
    const { emit, handlers } = installFakeChrome();
    handlers["action"] = () => {
      emit(CONTROLLED_TAB_ID, { url: "https://intranet.local/" });
      return [{ frameId: 0, result: { ok: true } }];
    };

    expect(await executeBrowserCommand(CONTROLLER_ID, click())).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
  });

  test("is unknown when going back cannot be observed", async () => {
    const { handlers } = installFakeChrome();
    handlers["back"] = () => [{ frameId: 0, result: undefined }];
    handlers["snapshot"] = () => {
      throw new TypeError("The page is being unloaded.");
    };

    expect(
      await executeBrowserCommand(CONTROLLER_ID, { action: "go-back" }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown });
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

    expect(await executeBrowserCommand(CONTROLLER_ID, click())).toMatchObject({
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

    const result = await executeBrowserCommand(CONTROLLER_ID, click());
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

    expect(
      await executeBrowserCommand(CONTROLLER_ID, click("e:3:0.1")),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.unsupportedPage });
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

    const result = await executeBrowserCommand(CONTROLLER_ID, {
      action: "open",
      url: PAGE_URL,
    });
    expect(result).toMatchObject({ status: "success" });
    expect(log.slice(0, 3)).toEqual([
      "create:about:blank",
      "rules:7",
      `update:${PAGE_URL}`,
    ]);
  });

  test("never adopts the controller's stella tab or a stella page", async () => {
    const { log } = installFakeChrome();
    // Even if the controller's tab showed a public page, it stays stella's.
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
    ).toEqual({ status: "adopted", url: PAGE_URL });
    expect(log).toEqual(["rules:5"]);
  });
});
