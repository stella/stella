import { afterEach, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
  STELLA_DESKTOP_NATIVE_HOST,
} from "@stll/api-contract/browser-control";

import {
  createDesktopLink,
  DESKTOP_LINK_STATE,
  type DesktopCommand,
  desktopControllerId,
  type DesktopLinkTimer,
  readDesktopLinkState,
} from "./desktop-link";

type Listener = (message: unknown) => void;

const createFakePort = () => {
  const messageListeners: Listener[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: unknown[] = [];
  const state = { disconnected: false };
  return {
    posted,
    state,
    port: {
      disconnect: () => {
        state.disconnected = true;
      },
      onDisconnect: {
        addListener: (listener: () => void) => {
          disconnectListeners.push(listener);
        },
      },
      onMessage: {
        addListener: (listener: Listener) => {
          messageListeners.push(listener);
        },
      },
      postMessage: (message: unknown) => {
        posted.push(message);
      },
    },
    deliver: (message: unknown) => {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    drop: () => {
      for (const listener of disconnectListeners) {
        listener();
      }
    },
  };
};

type FakePort = ReturnType<typeof createFakePort>;

const installFakeChrome = ({ allowed }: { allowed: boolean }) => {
  const session: Record<string, unknown> = {};
  const ports: FakePort[] = [];
  const hosts: string[] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      permissions: { contains: async () => allowed },
      runtime: {
        connectNative: (host: string) => {
          hosts.push(host);
          const fake = createFakePort();
          ports.push(fake);
          return fake.port;
        },
        lastError: undefined,
      },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(session, items);
          },
        },
      },
    },
  });
  return { hosts, ports };
};

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

/** Records reconnects; `fire` runs the earliest one now. */
const createManualTimer = () => {
  const pending: { delayMs: number; task: () => void }[] = [];
  const timer: DesktopLinkTimer = (task, delayMs) => {
    const entry = { delayMs, task };
    pending.push(entry);
    return () => {
      pending.splice(pending.indexOf(entry), 1);
    };
  };
  return {
    fire: () => {
      pending.shift()?.task();
    },
    pending,
    timer,
  };
};

const RESULT = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "Sign in first.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} as const satisfies BrowserControlResult;

const command = (requestId: string) => ({
  command: { action: "snapshot" },
  controllerId: "thread-1",
  observedTab: null,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  requestId,
  source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
  toolCallId: `call-${requestId}`,
  turnId: "run-1",
  type: "command",
});

test("stays offline without the member's permission", async () => {
  const { hosts } = installFakeChrome({ allowed: false });
  const link = createDesktopLink({
    cancel: () => undefined,
    runCommand: async () => RESULT,
    timer: createManualTimer().timer,
  });
  await link.connect();
  expect(hosts).toEqual([]);
  expect(await readDesktopLinkState()).toBe(DESKTOP_LINK_STATE.offline);
});

test("answers stella desktop's hello and runs its commands", async () => {
  const { hosts, ports } = installFakeChrome({ allowed: true });
  const ran: DesktopCommand[] = [];
  const answered = Promise.resolve(RESULT);
  const link = createDesktopLink({
    cancel: () => undefined,
    // The same promise the test awaits, so the result is posted first.
    runCommand: (request) => {
      ran.push(request);
      return answered;
    },
    timer: createManualTimer().timer,
  });
  await link.connect();
  await link.connect();
  expect(hosts).toEqual([STELLA_DESKTOP_NATIVE_HOST]);
  expect(await readDesktopLinkState()).toBe(DESKTOP_LINK_STATE.waiting);

  const [native] = ports;
  if (native === undefined) {
    throw new TypeError("No native port opened.");
  }
  native.deliver({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
    type: "hello",
  });
  expect(native.posted).toEqual([
    {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "hello",
    },
  ]);
  expect(await readDesktopLinkState()).toBe(DESKTOP_LINK_STATE.connected);

  native.deliver(command("r-1"));
  // A web page's message is not stella desktop's.
  native.deliver({ ...command("r-2"), source: "stella-web" });
  await answered;
  expect(ran.map(({ requestId }) => requestId)).toEqual(["r-1"]);
  expect(native.posted.at(-1)).toEqual({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: "r-1",
    result: RESULT,
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "command-result",
  });
});

test("drops a result whose connection is gone and reconnects", async () => {
  const { hosts, ports } = installFakeChrome({ allowed: true });
  const pending = Promise.withResolvers<BrowserControlResult>();
  const manual = createManualTimer();
  const link = createDesktopLink({
    cancel: () => undefined,
    runCommand: () => pending.promise,
    timer: manual.timer,
  });
  await link.connect();
  const [first] = ports;
  if (first === undefined) {
    throw new TypeError("No native port opened.");
  }
  first.deliver(command("r-1"));
  first.drop();
  pending.resolve(RESULT);
  await pending.promise;
  expect(first.posted).toEqual([]);
  expect(await readDesktopLinkState()).toBe(DESKTOP_LINK_STATE.offline);

  expect(manual.pending.map(({ delayMs }) => delayMs)).toEqual([2000]);
  manual.fire();
  await link.connect();
  expect(hosts).toHaveLength(2);
  await link.disconnect();
  expect(ports.at(1)?.state.disconnected).toBe(true);
  expect(await readDesktopLinkState()).toBe(DESKTOP_LINK_STATE.offline);
});

test("a desktop chat's controller never matches a web connection's", () => {
  const id = crypto.randomUUID();
  expect(desktopControllerId(id)).not.toBe(id);
  expect(desktopControllerId(id)).toBe(`desktop:${id}`);
});
