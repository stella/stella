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
};

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

const connect = () => {
  unmount = mountBrowserExtensionBridge();
  messageListener?.({
    data: {
      allSitesGranted: true,
      controllerId: "controller-1",
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: "ping-1",
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "pong",
    },
    origin: ORIGIN,
    source: fakeWindow,
  });
};

const postedCommands = () =>
  fakeWindow.posted.filter(({ type }) => type === "command");

const errorCode = (result: BrowserControlResult) =>
  result.status === "error" ? result.code : null;

describe("browser extension bridge outcomes", () => {
  test("a malformed command is invalid rather than a missing extension", async () => {
    connect();

    const result = await executeBrowserExtensionCommand(
      { ...click, target: { ...click.target, ref: "e:0:" } },
      "call-1",
    );

    expect(errorCode(result)).toBe(BROWSER_CONTROL_ERROR_CODE.invalidCommand);
    expect(postedCommands()).toHaveLength(0);
  });

  test("a command that never reached the extension stays disconnected", async () => {
    unmount = mountBrowserExtensionBridge();

    const result = await executeBrowserExtensionCommand(click, "call-1");

    expect(errorCode(result)).toBe(BROWSER_CONTROL_ERROR_CODE.disconnected);
    expect(postedCommands()).toHaveLength(0);
  });

  test("an unanswered action after posting has an unknown outcome", async () => {
    jest.useFakeTimers();
    connect();

    const pending = executeBrowserExtensionCommand(click, "call-1");
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

    const pending = executeBrowserExtensionCommand(snapshot, "call-1");
    jest.advanceTimersByTime(60_000);

    expect(errorCode(await pending)).toBe(BROWSER_CONTROL_ERROR_CODE.timedOut);
  });

  test("disconnecting with a posted action pending reports an unknown outcome", async () => {
    connect();

    const action = executeBrowserExtensionCommand(click, "call-1");
    const read = executeBrowserExtensionCommand(snapshot, "call-2");
    expect(postedCommands()).toHaveLength(2);
    unmount?.();
    unmount = null;

    expect(errorCode(await action)).toBe(
      BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    );
    expect(errorCode(await read)).toBe(BROWSER_CONTROL_ERROR_CODE.disconnected);
  });
});
