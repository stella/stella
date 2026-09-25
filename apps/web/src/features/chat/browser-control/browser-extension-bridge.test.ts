import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserExtensionRequest,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_APPROVAL_MODE,
  setBrowserApprovalMode,
} from "./browser-approval-mode";
import {
  executeBrowserExtensionCommand,
  mountBrowserExtensionBridge,
} from "./browser-extension-bridge";

const ORIGIN = "https://app.stella.test";

const click = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: { name: "Submit", ref: "e:0:0.1", role: "button" },
} satisfies BrowserControlCommand;
const snapshot = { action: "snapshot" } satisfies BrowserControlCommand;

type FakeWindow = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  location: { origin: string };
  posted: BrowserExtensionRequest[];
  postMessage: (message: BrowserExtensionRequest) => void;
  removeEventListener: (type: string) => void;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
};

const APPROVAL_MODE_KEY = "stella.chat.browserApprovalMode";
const storedValues = new Map<string, string>();

let previousWindow: PropertyDescriptor | undefined;
let messageListener: ((event: unknown) => void) | null = null;
let fakeWindow: FakeWindow;
let unmount: (() => void) | null = null;

beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  fakeWindow = {
    addEventListener: (type, listener) => {
      if (type === "message") {
        messageListener = listener;
      }
    },
    location: { origin: ORIGIN },
    posted: [],
    postMessage: (message) => {
      fakeWindow.posted.push(message);
    },
    removeEventListener: (type) => {
      if (type === "message") {
        messageListener = null;
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
  jest.useRealTimers();
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

const deliver = (data: unknown) => {
  messageListener?.({ data, origin: ORIGIN, source: fakeWindow });
};

const report = (
  controllerId: string | null,
  controlledTabId: number | null = null,
) => {
  deliver({
    allSitesGranted: true,
    controlledTabId,
    controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "pong",
  });
};

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
      revision,
      tabId,
      text: "",
      textOffset: 0,
      textTotalChars: 0,
      title: "Example",
      url: "https://example.com/",
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

describe("approval after the controlled tab changes", () => {
  const autoApprovesReads = () =>
    storedValues.get(APPROVAL_MODE_KEY) ===
    JSON.stringify(BROWSER_APPROVAL_MODE.autoApproveReads);

  test("the first report from the extension keeps the reads opt-in", () => {
    connect();
    setBrowserApprovalMode(BROWSER_APPROVAL_MODE.autoApproveReads);
    report("controller-1");

    expect(autoApprovesReads()).toBe(true);
  });

  test("re-pairing, disconnecting and handing over a tab each ask again", () => {
    for (const change of [
      () => report("controller-2"),
      () => report(null),
      () => report("controller-1", 9),
    ]) {
      unmount?.();
      unmount = null;
      connect();
      setBrowserApprovalMode(BROWSER_APPROVAL_MODE.autoApproveReads);

      change();

      expect(autoApprovesReads()).toBe(false);
    }
  });

  test("a tab chat itself opened does not count as a change", async () => {
    connect();
    setBrowserApprovalMode(BROWSER_APPROVAL_MODE.autoApproveReads);
    const opened = executeBrowserExtensionCommand(
      { action: "open", url: "https://example.com/" },
      "call-1",
      run(),
    );
    const [posted] = postedCommands();
    if (!posted) {
      throw new TypeError("No command posted");
    }
    answer(posted.requestId, snapshotResult(7, "revision-1"));
    await opened;
    report("controller-1", 7);

    expect(autoApprovesReads()).toBe(true);
  });
});
