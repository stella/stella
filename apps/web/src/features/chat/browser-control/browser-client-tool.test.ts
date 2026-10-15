import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TOOL_NAME,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserExtensionRequest,
} from "@stll/api-contract/browser-control";

import { createUuid } from "@/lib/uuid";

import { createBrowserClientTool } from "./browser-client-tool";
import { mountBrowserExtensionBridge } from "./browser-extension-bridge";

describe("chat browser client tool", () => {
  test("registers the approved browser command as a native client tool", () => {
    const { tool } = createBrowserClientTool({ turnIdFor: () => "turn-1" });

    expect(tool).toMatchObject({
      __toolSide: "client",
      name: BROWSER_CONTROL_TOOL_NAME,
      needsApproval: true,
    });
    expect(tool.execute).toBeFunction();
  });
});

const ORIGIN = "https://app.stella.test";

type FakeWindow = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  location: { origin: string };
  posted: BrowserExtensionRequest[];
  postMessage: (message: BrowserExtensionRequest) => void;
  removeEventListener: (type: string) => void;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
};

let previousWindow: PropertyDescriptor | undefined;
let messageListener: ((event: unknown) => void) | null = null;
let fakeWindow: FakeWindow;
let unmount: (() => void) | null = null;

beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stored = new Map<string, string>();
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
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
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
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

const deliver = (data: unknown) => {
  messageListener?.({ data, origin: ORIGIN, source: fakeWindow });
};

const connect = () => {
  unmount = mountBrowserExtensionBridge();
  deliver({
    allSitesGranted: true,
    controlledTabId: null,
    controllerId: "controller-1",
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: createUuid(),
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "pong",
  });
};

const postedCommands = () =>
  fakeWindow.posted.filter(
    (
      request,
    ): request is Extract<BrowserExtensionRequest, { type: "command" }> =>
      request.type === "command",
  );

const errorCode = (result: unknown) =>
  typeof result === "object" &&
  result !== null &&
  "status" in result &&
  result.status === "error" &&
  "code" in result
    ? result.code
    : null;

/** What TanStack passes a client tool that runs a call. */
const executionContext = (toolCallId: string) => ({
  emitCustomEvent: () => undefined,
  toolCallId,
});

describe("browser commands after a stop", () => {
  test("a stopped turn's command never runs until a regeneration resumes the turn", async () => {
    connect();
    // A regeneration reruns the same user message, so the same turn.
    const browser = createBrowserClientTool({ turnIdFor: () => "user-1" });

    browser.cancel();
    const stopped = await browser.tool.execute?.(
      { action: "snapshot" },
      executionContext("call-1"),
    );
    expect(errorCode(stopped)).toBe(BROWSER_CONTROL_ERROR_CODE.cancelled);
    expect(postedCommands()).toHaveLength(0);

    browser.resume();
    const resumed = browser.tool.execute?.(
      { action: "snapshot" },
      executionContext("call-2"),
    );
    await Promise.resolve();
    expect(postedCommands()).toEqual([
      expect.objectContaining({ toolCallId: "call-2", turnId: "user-1" }),
    ]);

    // Stopping again ends it.
    browser.cancel();
    expect(errorCode(await resumed)).toBe(BROWSER_CONTROL_ERROR_CODE.cancelled);
  });
});
