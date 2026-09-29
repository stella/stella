import { afterEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import {
  adoptControlledTab,
  executeBrowserCommand,
  replaceControlledTab,
} from "./tab-executor";

type TabChange = { status?: string; url?: string };
type FakeTab = { id: number; status: string; url: string };
type Injection = {
  args?: [{ kind: string }];
  target: { documentIds?: string[]; frameIds?: number[]; tabId: number };
};
type InjectionResult = {
  documentId?: string;
  frameId: number;
  result: unknown;
}[];

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

  const hooks = { afterCreate: (): void => undefined };

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
        return { ...tab };
      },
      goBack: async () => undefined,
      query: async () => structuredClone([...tabs.values()]),
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

  return { chrome, emit, handlers, hooks, log, probe, session, tabs };
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
    ).toEqual({ status: "adopted", tabId: 5, url: PAGE_URL });
    expect(log).toEqual([
      `rules:except:${CONTROLLER_TAB_ID},${CONTROLLED_TAB_ID},-1`,
    ]);
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
