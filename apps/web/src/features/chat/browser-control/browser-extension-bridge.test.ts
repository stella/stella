import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserExtensionRequest,
} from "@stll/api-contract/browser-control";
import { DESKTOP_RUNNER_APPROVAL_MODES } from "@stll/api-contract/desktop-runner";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import { buildSendRequestBody } from "@/features/chat/chat-runtime";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { createUuid } from "@/lib/uuid";

import {
  beginBrowserCommand,
  currentBrowserStepDecision,
} from "./browser-approval-state";
import { listenForBrowserExtensionAnnouncement } from "./browser-extension-announcement";
import {
  BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS,
  browserExtensionSupport,
  executeBrowserExtensionCommand,
  getBrowserExtensionState,
  isBrowserExtensionBridgeMounted,
  mountBrowserExtensionBridge,
} from "./browser-extension-bridge";

const ORIGIN = "https://app.stella.test";

const click = {
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
const snapshot = { action: "snapshot" } satisfies BrowserControlCommand;

type FakeWindow = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  location: { origin: string };
  posted: BrowserExtensionRequest[];
  postMessage: (message: BrowserExtensionRequest) => void;
  removeEventListener: (
    type: string,
    listener: (event: unknown) => void,
  ) => void;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
};

const storedValues = new Map<string, string>();

let previousWindow: PropertyDescriptor | undefined;
let previousNavigator: PropertyDescriptor | undefined;
const messageListeners = new Set<(event: unknown) => void>();
let fakeWindow: FakeWindow;
let unmount: (() => void) | null = null;

beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" },
  });
  fakeWindow = {
    addEventListener: (type, listener) => {
      if (type === "message") {
        messageListeners.add(listener);
      }
    },
    location: { origin: ORIGIN },
    posted: [],
    postMessage: (message) => {
      fakeWindow.posted.push(message);
    },
    removeEventListener: (type, listener) => {
      if (type === "message") {
        messageListeners.delete(listener);
      }
    },
    sessionStorage: {
      getItem: (key) => storedValues.get(key) ?? null,
      setItem: (key, value) => {
        storedValues.set(key, value);
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
});

afterEach(() => {
  unmount?.();
  unmount = null;
  restoreRealTimers();
  if (previousNavigator) {
    Object.defineProperty(globalThis, "navigator", previousNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

const deliver = (data: unknown) => {
  for (const listener of messageListeners) {
    listener({ data, origin: ORIGIN, source: fakeWindow });
  }
};

const report = (
  controllerId: string | null,
  controlledTabId: number | null = null,
  allSitesGranted = true,
) => {
  deliver({
    allSitesGranted,
    controlledTabId,
    controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: createUuid(),
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "pong",
  });
};

describe("Chromium extension support", () => {
  test.each([
    {
      name: "Chrome",
      browser: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" },
      support: "supported",
    },
    {
      name: "Chromium",
      browser: { userAgent: "Mozilla/5.0 Chromium/140.0.0.0" },
      support: "supported",
    },
    {
      name: "Edge",
      browser: {
        userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      },
      support: "supported",
    },
    {
      name: "Brave brands",
      browser: {
        userAgent: "reduced",
        userAgentData: { brands: [{ brand: "Brave" }, { brand: "Chromium" }] },
      },
      support: "supported",
    },
    {
      name: "Google Chrome brands",
      browser: {
        userAgent: "reduced",
        userAgentData: { brands: [{ brand: "Google Chrome" }] },
      },
      support: "supported",
    },
    {
      name: "unknown brands override UA",
      browser: {
        userAgent: "Chrome/140",
        userAgentData: { brands: [{ brand: "Unknown" }] },
      },
      support: "unsupported-browser",
    },
    {
      name: "Firefox",
      browser: { userAgent: "Mozilla/5.0 Firefox/140.0" },
      support: "unsupported-browser",
    },
    {
      name: "iOS Firefox",
      browser: { userAgent: "Mozilla/5.0 FxiOS/140.0 Safari/605.1.15" },
      support: "unsupported-device",
    },
    {
      name: "Safari",
      browser: { userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15" },
      support: "unsupported-browser",
    },
    {
      name: "iPad Safari asking for the desktop site",
      browser: {
        maxTouchPoints: 5,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
      },
      support: "unsupported-device",
    },
    {
      name: "Mac Safari",
      browser: {
        maxTouchPoints: 0,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
      },
      support: "unsupported-browser",
    },
    {
      name: "Mac Chrome",
      browser: {
        maxTouchPoints: 0,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36",
      },
      support: "supported",
    },
    {
      name: "iOS Chrome",
      browser: { userAgent: "Mozilla/5.0 (iPhone) CriOS/140.0 Safari/604.1" },
      support: "unsupported-device",
    },
    {
      name: "iOS with Chromium brands",
      browser: {
        userAgent: "Mozilla/5.0 (iPad) CriOS/140.0",
        userAgentData: { brands: [{ brand: "Chromium" }] },
      },
      support: "unsupported-device",
    },
    {
      name: "Android Chrome",
      browser: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14) Chrome/140.0.0.0 Mobile Safari/537.36",
      },
      support: "unsupported-device",
    },
    {
      name: "mobile Chromium brands",
      browser: {
        userAgent: "reduced",
        userAgentData: { brands: [{ brand: "Chromium" }], mobile: true },
      },
      support: "unsupported-device",
    },
    {
      name: "unknown browser",
      browser: { userAgent: "UnknownBrowser/1.0" },
      support: "unsupported-browser",
    },
    {
      name: "missing navigator",
      browser: undefined,
      support: "unsupported-device",
    },
  ] as const)("$name", ({ browser, support }) => {
    expect(browserExtensionSupport(browser)).toBe(support);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: browser,
    });
    expect(getBrowserExtensionState().status).toBe(
      support === "supported" ? "not-installed" : support,
    );
  });
});

describe("live browser extension state", () => {
  test("discovery stays checking until the deadline, including after remount", () => {
    jest.useFakeTimers();
    for (let mount = 0; mount < 2; mount += 1) {
      unmount = mountBrowserExtensionBridge();
      expect(getBrowserExtensionState().status).toBe("checking");
      jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS - 1);
      expect(getBrowserExtensionState().status).toBe("checking");
      jest.advanceTimersByTime(1);
      expect(getBrowserExtensionState().status).toBe("not-installed");
      unmount();
      unmount = null;
    }
  });

  test("an announcement resolves checking before the deadline", () => {
    jest.useFakeTimers();
    unmount = mountBrowserExtensionBridge();
    expect(getBrowserExtensionState().status).toBe("checking");
    report(null);
    expect(getBrowserExtensionState().status).toBe("not-paired");
    jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
    expect(getBrowserExtensionState().status).toBe("not-paired");
  });

  test.each([
    {
      side: "an older extension waits for its update",
      version: BROWSER_CONTROL_PROTOCOL_VERSION - 1,
      status: "extension-outdated",
    },
    {
      side: "a newer extension asks for a reload of this tab",
      version: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
      status: "stella-outdated",
    },
  ])("$side, never reads as not installed", ({ status, version }) => {
    jest.useFakeTimers();
    unmount = mountBrowserExtensionBridge();
    // Another version's announcement: same source and version fields, a
    // shape this tab's protocol does not accept.
    deliver({
      allSitesGranted: true,
      protocolVersion: version,
      requestId: "extension-ready",
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "pong",
    });
    expect(getBrowserExtensionState().status).toBe(status);
    jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
    expect(getBrowserExtensionState().status).toBe(status);
    // Once Chrome updated the extension, it reports on this tab's protocol.
    report("controller-1");
    expect(getBrowserExtensionState().status).toBe("connected");
  });

  test.each([
    {
      side: "an older extension",
      version: BROWSER_CONTROL_PROTOCOL_VERSION - 1,
      status: "extension-outdated",
    },
    {
      side: "a newer extension",
      version: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
      status: "stella-outdated",
    },
  ])(
    "$side that announced itself before the bridge mounted is not taken for missing",
    ({ status, version }) => {
      jest.useFakeTimers();
      const stopListening = listenForBrowserExtensionAnnouncement();
      try {
        // The content script loads before the app shell mounts the bridge,
        // and ignores this tab's pings because their version differs.
        deliver({
          allSitesGranted: false,
          protocolVersion: version,
          requestId: "extension-ready",
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "pong",
        });
        unmount = mountBrowserExtensionBridge();
        jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
        expect(getBrowserExtensionState().status).toBe(status);
      } finally {
        stopListening();
      }
    },
  );

  test("an announcement on this protocol heard before mount waits for a live answer", () => {
    jest.useFakeTimers();
    const stopListening = listenForBrowserExtensionAnnouncement();
    try {
      deliver({
        allSitesGranted: false,
        controlledTabId: null,
        controllerId: null,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "extension-ready",
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "pong",
      });
      fakeWindow.posted = [];
      unmount = mountBrowserExtensionBridge();
      // Only the mount ping: the extension on this version answers it.
      expect(fakeWindow.posted.map(({ type }) => type)).toEqual(["ping"]);
      expect(getBrowserExtensionState().status).toBe("checking");
      report(null, null, false);
      jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
      expect(getBrowserExtensionState().status).toBe("needs-site-access");
    } finally {
      stopListening();
    }
  });

  test("an announcement on this protocol with no live answer after mount is not installed", () => {
    jest.useFakeTimers();
    const stopListening = listenForBrowserExtensionAnnouncement();
    try {
      // Disabled after it announced itself: nothing answers the mount ping.
      deliver({
        allSitesGranted: false,
        controlledTabId: null,
        controllerId: null,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "extension-ready",
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "pong",
      });
      unmount = mountBrowserExtensionBridge();
      jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
      expect(getBrowserExtensionState().status).toBe("not-installed");
    } finally {
      stopListening();
    }
  });

  test("a message from a stella page is not taken for an extension", () => {
    jest.useFakeTimers();
    unmount = mountBrowserExtensionBridge();
    deliver({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION - 1,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
    });
    jest.advanceTimersByTime(BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
    expect(getBrowserExtensionState().status).toBe("not-installed");
  });
  test("covers discovery, permission, pairing, disconnect, and late installation", () => {
    jest.useFakeTimers();
    unmount = mountBrowserExtensionBridge();

    jest.advanceTimersByTime(1000);
    expect(getBrowserExtensionState().status).toBe("not-installed");

    report(null, null, false);
    expect(getBrowserExtensionState().status).toBe("needs-site-access");

    report(null);
    expect(getBrowserExtensionState().status).toBe("not-paired");

    report("controller-1");
    expect(getBrowserExtensionState().status).toBe("connected");

    report(null);
    expect(getBrowserExtensionState().status).toBe("not-paired");

    report("controller-2");
    expect(getBrowserExtensionState().status).toBe("connected");
    report(null); // A different stella tab now owns the controller.
    expect(getBrowserExtensionState().status).toBe("not-paired");

    unmount();
    unmount = null;
    expect(getBrowserExtensionState().status).toBe("not-installed");
  });
});

const connect = () => {
  unmount = mountBrowserExtensionBridge();
  report("controller-1");
};

const run = (signal = new AbortController().signal) => ({
  signal,
  turnId: "turn-1",
});

const postedCommands = () =>
  fakeWindow.posted.filter(
    (
      request,
    ): request is Extract<BrowserExtensionRequest, { type: "command" }> =>
      request.type === "command",
  );

const postedCancels = () =>
  fakeWindow.posted.filter(({ type }) => type === "cancel");

const answer = (requestId: string, result: BrowserControlResult) => {
  deliver({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId,
    result,
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "command-result",
  });
};

const snapshotResult = (tabId: number, revision: string) =>
  ({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: "untrusted-web-content",
      elements: [],
      elementsLeftOut: false,
      facts: { meta: [] },
      revision,
      tabId,
      tabs: [{ active: true, tabId, url: "https://example.com/" }],
      text: "",
      title: "Example",
      url: "https://example.com/",
      window: { cursor: "r1.window", fromPercent: 0, toPercent: 100 },
    },
    status: "success",
  }) satisfies BrowserControlResult;

const errorCode = (result: BrowserControlResult) =>
  result.status === "error" ? result.code : null;

describe("browser extension bridge outcomes", () => {
  test("a malformed command is invalid rather than a missing extension", async () => {
    connect();

    const result = await executeBrowserExtensionCommand(
      { ...click, target: { ...click.target, ref: "e:0:" } },
      "call-1",
      run(),
    );

    expect(errorCode(result)).toBe(BROWSER_CONTROL_ERROR_CODE.invalidCommand);
    expect(postedCommands()).toHaveLength(0);
  });

  test("a command that never reached the extension stays disconnected", async () => {
    unmount = mountBrowserExtensionBridge();

    const result = await executeBrowserExtensionCommand(click, "call-1", run());

    expect(errorCode(result)).toBe(BROWSER_CONTROL_ERROR_CODE.disconnected);
    expect(postedCommands()).toHaveLength(0);
  });

  test("an unanswered action after posting has an unknown outcome", async () => {
    jest.useFakeTimers();
    connect();

    const pending = executeBrowserExtensionCommand(click, "call-1", run());
    expect(postedCommands()).toHaveLength(1);
    jest.advanceTimersByTime(60_000);
    const result = await pending;

    expect(errorCode(result)).toBe(BROWSER_CONTROL_ERROR_CODE.outcomeUnknown);
    expect(result.status === "error" && result.message).toContain(
      "take a snapshot before retrying",
    );
  });

  test("an unanswered read after posting simply timed out", async () => {
    jest.useFakeTimers();
    connect();

    const pending = executeBrowserExtensionCommand(snapshot, "call-1", run());
    jest.advanceTimersByTime(60_000);

    expect(errorCode(await pending)).toBe(BROWSER_CONTROL_ERROR_CODE.timedOut);
  });

  test("disconnecting with a posted action pending reports an unknown outcome", async () => {
    connect();

    const action = executeBrowserExtensionCommand(click, "call-1", run());
    const read = executeBrowserExtensionCommand(snapshot, "call-2", run());
    expect(postedCommands()).toHaveLength(2);
    unmount?.();
    unmount = null;

    expect(errorCode(await action)).toBe(
      BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    );
    expect(errorCode(await read)).toBe(BROWSER_CONTROL_ERROR_CODE.disconnected);
  });
});

describe("stopping browser commands from chat", () => {
  test("a stop ends a running action at once and tells the extension", async () => {
    connect();
    const stop = new AbortController();

    const action = executeBrowserExtensionCommand(
      click,
      "call-1",
      run(stop.signal),
    );
    stop.abort();

    expect(errorCode(await action)).toBe(
      BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    );
    expect(postedCancels()).toEqual([
      expect.objectContaining({
        controllerId: "controller-1",
        turnId: "turn-1",
        type: "cancel",
      }),
    ]);
  });

  test("a stopped read is cancelled, and one stopped before posting never runs", async () => {
    connect();
    const stop = new AbortController();

    const read = executeBrowserExtensionCommand(
      snapshot,
      "call-1",
      run(stop.signal),
    );
    stop.abort();
    expect(errorCode(await read)).toBe(BROWSER_CONTROL_ERROR_CODE.cancelled);

    const late = await executeBrowserExtensionCommand(
      click,
      "call-2",
      run(stop.signal),
    );
    expect(errorCode(late)).toBe(BROWSER_CONTROL_ERROR_CODE.cancelled);
    expect(postedCommands()).toHaveLength(1);
  });

  test("a stop after the answer changes nothing", async () => {
    connect();
    const stop = new AbortController();

    const read = executeBrowserExtensionCommand(
      snapshot,
      "call-1",
      run(stop.signal),
    );
    const [posted] = postedCommands();
    if (!posted) {
      throw new TypeError("No command posted");
    }
    answer(posted.requestId, snapshotResult(7, "revision-1"));
    expect((await read).status).toBe("success");
    stop.abort();

    expect(postedCancels()).toEqual([]);
  });
});

describe("command identity", () => {
  test("every command carries the turn and the tab of the last successful result", async () => {
    connect();

    const first = executeBrowserExtensionCommand(snapshot, "call-1", run());
    const [firstPosted] = postedCommands();
    if (!firstPosted) {
      throw new TypeError("No command posted");
    }
    expect(firstPosted).toMatchObject({ observedTab: null, turnId: "turn-1" });
    answer(firstPosted.requestId, snapshotResult(7, "revision-1"));
    await first;

    void executeBrowserExtensionCommand(click, "call-2", run());
    expect(postedCommands().at(1)).toMatchObject({
      observedTab: { revision: "revision-1", tabId: 7 },
    });
  });
});

describe("the reported page after the controlled tab changes", () => {
  const GRANTED = new Set(["https://example.com"]);
  /** Whether a website approval answers a click on the page last read. */
  const grantAnswersClick = () =>
    currentBrowserStepDecision({
      command: click,
      grantedOrigins: GRANTED,
      level: "ask",
      threadId: null,
    }).type === "run";

  /** Reads tab 7 at revision-1 through the extension, as the executor does. */
  const readPage = async () => {
    const finish = beginBrowserCommand();
    const read = executeBrowserExtensionCommand(
      { action: "open", url: "https://example.com/" },
      `call-${createUuid()}`,
      run(),
    );
    const posted = postedCommands().at(-1);
    if (!posted) {
      throw new TypeError("No command posted");
    }
    answer(posted.requestId, snapshotResult(7, "revision-1"));
    finish((await read).status === "success");
  };

  test("a page chat itself read stays reported when the extension confirms its tab", async () => {
    connect();
    await readPage();
    report("controller-1", 7);

    expect(grantAnswersClick()).toBe(true);
  });

  test("re-pairing, disconnecting and handing over a tab each forget the page", async () => {
    for (const change of [
      () => report("controller-2", 7),
      () => report(null),
      () => report("controller-1", 9),
    ]) {
      unmount?.();
      unmount = null;
      connect();
      await readPage();
      expect(grantAnswersClick()).toBe(true);

      change();

      expect(grantAnswersClick()).toBe(false);
    }
  });

  test("an answer to a command sent before the pairing changed reports nothing", async () => {
    connect();
    const finish = beginBrowserCommand();
    const read = executeBrowserExtensionCommand(
      { action: "open", url: "https://example.com/" },
      "call-before-re-pairing",
      run(),
    );
    const posted = postedCommands().at(-1);
    if (!posted) {
      throw new TypeError("No command posted");
    }
    report("controller-2", 7);
    answer(posted.requestId, snapshotResult(7, "revision-1"));
    finish((await read).status === "success");
    // A command under the new pairing settles; the late page still counts
    // for nothing.
    beginBrowserCommand()(true);

    expect(grantAnswersClick()).toBe(false);
  });

  test("a sign-in hand-over holds every step on the page until it is read again", async () => {
    connect();
    await readPage();
    const finish = beginBrowserCommand();
    const clicked = executeBrowserExtensionCommand(
      click,
      "call-sign-in",
      run(),
    );
    const posted = postedCommands().at(-1);
    if (!posted) {
      throw new TypeError("No command posted");
    }
    answer(posted.requestId, {
      code: BROWSER_CONTROL_ERROR_CODE.needsMember,
      message: "The page asks for a sign-in.",
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "error",
    });
    finish((await clicked).status !== "error");
    for (const level of DESKTOP_RUNNER_APPROVAL_MODES) {
      expect(
        currentBrowserStepDecision({
          command: click,
          grantedOrigins: GRANTED,
          level,
          threadId: null,
        }),
      ).toEqual({ type: "needs_member" });
    }
    await readPage();
    expect(grantAnswersClick()).toBe(true);
  });
});

describe("the bridge outlives every chat surface", () => {
  const sendBody = () => {
    const threadId = toChatThreadId("thread-new");
    return buildSendRequestBody({
      context: {},
      key: { scope: "global", threadId },
      messages: [
        {
          id: createUuid(),
          parts: [{ content: "hello", type: "text" }],
          role: "user",
        },
      ],
      run: { runId: "run-new", threadId },
    });
  };

  test("a send during discovery reports checking", () => {
    jest.useFakeTimers();
    unmount = mountBrowserExtensionBridge();
    expect(sendBody().browserExtension).toEqual({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "checking",
    });
  });

  test("the first send of a fresh chat carries the browser client once the extension answered", () => {
    connect();

    expect(sendBody().browserExtension).toEqual({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "connected",
    });
  });

  test("a send without a mounted bridge reports the extension as not installed", () => {
    expect(isBrowserExtensionBridgeMounted()).toBe(false);
    expect(sendBody().browserExtension).toEqual({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "not-installed",
    });
  });

  test("surfaces coming and going under the frame keep the pairing", () => {
    connect();
    const surface = mountBrowserExtensionBridge();
    surface();

    expect(isBrowserExtensionBridgeMounted()).toBe(true);
    expect(getBrowserExtensionState()).toBeDefined();
    expect(sendBody().browserExtension).toBeDefined();
  });
});

describe("the bridge mount site", () => {
  test("only the app frame host mounts the bridge", async () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const mounters: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
      if (
        file.includes(".test.") ||
        file.endsWith("browser-extension-bridge.ts")
      ) {
        continue;
      }
      if (
        (await Bun.file(path.join(root, file)).text()).includes(
          "mountBrowserExtensionBridge",
        )
      ) {
        mounters.push(file);
      }
    }

    expect(mounters).toEqual(["routes/-app-frame-host.tsx"]);
  });
});
