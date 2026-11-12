import { panic } from "better-result";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
  type BrowserDesktopRequest,
  type BrowserDesktopResponse,
  parseBrowserDesktopRequest,
  STELLA_DESKTOP_NATIVE_HOST,
} from "@stll/api-contract/browser-control";

import { hasDesktopLinkAccess } from "./access";
import { BROWSER_DESKTOP_LINK_STORAGE_KEY } from "./storage-keys";

/**
 * The extension's side of stella desktop's native messaging host. A coding
 * agent on the member's computer sends commands through it; their results
 * go back the same way and never through stella's servers. The connection
 * holds while the member allows it (the optional `nativeMessaging`
 * permission); a dropped one is retried with growing delays while the
 * worker runs, and again whenever the worker starts.
 */

export const DESKTOP_LINK_STATE = {
  /** stella desktop answered and takes commands. */
  connected: "connected",
  /** The member has not allowed it, or stella desktop is not running. */
  offline: "offline",
  /** The host started; stella desktop has not answered yet. */
  waiting: "waiting",
} as const;

export type DesktopLinkState =
  (typeof DESKTOP_LINK_STATE)[keyof typeof DESKTOP_LINK_STATE];

const DESKTOP_LINK_STATES: ReadonlySet<string> = new Set(
  Object.values(DESKTOP_LINK_STATE),
);

const isDesktopLinkState = (value: unknown): value is DesktopLinkState =>
  typeof value === "string" && DESKTOP_LINK_STATES.has(value);

export const readDesktopLinkState = async (): Promise<DesktopLinkState> => {
  const stored = await chrome.storage.session.get(
    BROWSER_DESKTOP_LINK_STORAGE_KEY,
  );
  const state: unknown = stored[BROWSER_DESKTOP_LINK_STORAGE_KEY];
  return isDesktopLinkState(state) ? state : DESKTOP_LINK_STATE.offline;
};

const writeDesktopLinkState = async (state: DesktopLinkState) => {
  await chrome.storage.session.set({
    [BROWSER_DESKTOP_LINK_STORAGE_KEY]: state,
  });
};

/**
 * The id a desktop chat's commands run under. Prefixed, so it can never be
 * a web connection's (a random UUID) and never reaches that connection's
 * controlled tab, receipts or budget.
 */
export const desktopControllerId = (controllerId: string): string =>
  `desktop:${controllerId}`;

export type DesktopCommand = Extract<
  BrowserDesktopRequest,
  { type: "command" }
>;
type DesktopCancel = Extract<BrowserDesktopRequest, { type: "cancel" }>;

/** How Chrome reports a native messaging host that is not installed. */
const MISSING_HOST_MESSAGE = "host not found";

/** Delays before reconnecting after a drop, the last one repeated. */
const DESKTOP_RECONNECT_DELAYS_MS = [2000, 5000, 15_000, 30_000];

/** Runs `task` after `delayMs`; the returned function cancels it. */
export type DesktopLinkTimer = (
  task: () => void,
  delayMs: number,
) => () => void;

export const realDesktopLinkTimer: DesktopLinkTimer = (task, delayMs) => {
  const timer = setTimeout(task, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

type DesktopLinkOptions = {
  /** Runs one command through the worker's control session. */
  runCommand: (command: DesktopCommand) => Promise<BrowserControlResult>;
  /** Stops the run's queued or running command, as chat's Stop does. */
  cancel: (request: DesktopCancel) => void;
  /** Schedules reconnects. */
  timer: DesktopLinkTimer;
};

export const createDesktopLink = ({
  cancel,
  runCommand,
  timer,
}: DesktopLinkOptions) => {
  let current: chrome.runtime.Port | null = null;
  let attempts = 0;
  let retry: (() => void) | null = null;

  const send = (port: chrome.runtime.Port, message: BrowserDesktopResponse) => {
    // A result for a connection that has since dropped has no reader.
    if (current === port) {
      port.postMessage(message);
    }
  };

  const handle = (from: chrome.runtime.Port, raw: unknown) => {
    const request = parseBrowserDesktopRequest(raw);
    if (request === null) {
      return;
    }
    switch (request.type) {
      case "hello":
        attempts = 0;
        send(from, {
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "hello",
        });
        writeDesktopLinkState(DESKTOP_LINK_STATE.connected).catch(
          () => undefined,
        );
        return;
      case "command":
        runCommand(request)
          .then((result) => {
            send(from, {
              protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
              requestId: request.requestId,
              result,
              source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
              type: "command-result",
            });
            return undefined;
          })
          .catch(() => undefined);
        return;
      case "cancel":
        cancel(request);
        return;
      default:
        request satisfies never;
        panic("Unhandled desktop request");
    }
  };

  const schedule = () => {
    if (retry !== null) {
      return;
    }
    const delay =
      DESKTOP_RECONNECT_DELAYS_MS.at(
        Math.min(attempts, DESKTOP_RECONNECT_DELAYS_MS.length - 1),
      ) ?? panic("The reconnect delays are empty");
    attempts += 1;
    retry = timer(() => {
      retry = null;
      connect().catch(() => undefined);
    }, delay);
  };

  const dropped = (closed: chrome.runtime.Port, reason: string | null) => {
    if (current !== closed) {
      return;
    }
    current = null;
    writeDesktopLinkState(DESKTOP_LINK_STATE.offline).catch(() => undefined);
    // stella desktop is not installed: it will not appear within seconds.
    if (reason?.includes(MISSING_HOST_MESSAGE) === true) {
      attempts = DESKTOP_RECONNECT_DELAYS_MS.length - 1;
    }
    schedule();
  };

  const connect = async (): Promise<void> => {
    if (current !== null) {
      return;
    }
    if (!(await hasDesktopLinkAccess())) {
      await writeDesktopLinkState(DESKTOP_LINK_STATE.offline);
      return;
    }
    // Checked again after the await: another start may have connected.
    if (current !== null) {
      return;
    }
    const opened = chrome.runtime.connectNative(STELLA_DESKTOP_NATIVE_HOST);
    current = opened;
    opened.onMessage.addListener((raw: unknown) => {
      handle(opened, raw);
    });
    opened.onDisconnect.addListener(() => {
      // Chrome says why in `lastError`; reading it marks it handled.
      dropped(opened, chrome.runtime.lastError?.message ?? null);
    });
    await writeDesktopLinkState(DESKTOP_LINK_STATE.waiting);
  };

  return {
    /** Connects unless connected; safe to call on every worker start. */
    connect,
    /** Drops the connection, as when the member takes the permission back. */
    disconnect: async () => {
      const open = current;
      current = null;
      retry?.();
      retry = null;
      open?.disconnect();
      await writeDesktopLinkState(DESKTOP_LINK_STATE.offline);
    },
  };
};
