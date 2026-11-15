import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
} from "@stll/api-contract/browser-control";

import { type BrowserBridge, browserBridgeError } from "./bridge";
import type { BrowserHost, BrowserHostRequest } from "./browser-host";
import {
  type LocalBrowserResult,
  localBrowserResult,
  readLocalBrowserResult,
} from "./local-result";

/**
 * Which browser a chat's commands go to: the one owner of that choice,
 * behind the tools' single `send`. Without the stella browser (the
 * development switch off) every command goes to the extension, exactly as
 * before. With it, a chat's `open` goes to the member's Chrome when the
 * extension is connected and speaks this holder's protocol, and to the
 * stella browser otherwise; the chat's other commands follow its last
 * `open`, since tabs and refs belong to one browser.
 */

export type ExtensionHost = {
  host: BrowserHost;
  /** Connected, and speaking the protocol this holder speaks. */
  ready: () => boolean;
};

/** The extension as a host: ready once connected and speaking this holder's protocol. */
export const extensionHost = (bridge: BrowserBridge): ExtensionHost => ({
  host: {
    acts: true,
    cancel: bridge.cancel,
    releaseChat: () => undefined,
    request: bridge.request,
  },
  ready: () => {
    const status = bridge.status();
    return (
      status.type === "ready" &&
      status.protocolVersion === BROWSER_CONTROL_PROTOCOL_VERSION
    );
  },
});

type HostRouterOptions = {
  extension: ExtensionHost | null;
  /** `null` while the development switch is off. */
  stellaBrowser: BrowserHost | null;
};

/**
 * Whether an open left the chat a page in that browser: read, or waiting
 * there for the member to sign in.
 */
const openedIn = (result: LocalBrowserResult): boolean => {
  const read = readLocalBrowserResult(result);
  return (
    read.status === "success" ||
    (read.status === "error" &&
      read.code === BROWSER_CONTROL_ERROR_CODE.needsMember)
  );
};

const NO_BROWSER =
  "stella cannot reach a browser on this computer. Ask the member to open Chrome with the stella extension and choose Use with stella desktop, then try again.";

export const createHostRouter = ({
  extension,
  stellaBrowser,
}: HostRouterOptions) => {
  /** The host each chat's pages are in: where its last opened page opened. */
  const chats = new Map<string, BrowserHost>();
  /** How often each chat's pages moved from one browser to the other. */
  const moves = new Map<string, number>();

  /** Where a chat opens a page now. */
  const choose = (): BrowserHost | null => {
    if (stellaBrowser !== null && extension?.ready() !== true) {
      return stellaBrowser;
    }
    return extension?.host ?? null;
  };

  /** The host a chat's command goes to. */
  const hostFor = (
    controllerId: string,
    action: BrowserHostRequest["command"]["action"],
  ): BrowserHost | null => {
    if (action === BROWSER_CONTROL_ACTION.open) {
      return choose();
    }
    return chats.get(controllerId) ?? choose();
  };

  const hosts = () =>
    [extension?.host ?? null, stellaBrowser].filter((host) => host !== null);

  const router: BrowserHost & {
    /** Whether a chat's page-changing steps can run where its pages are. */
    actsFor: (controllerId: string) => boolean;
    /** How often the chat's pages moved to another browser. */
    browserMoves: (controllerId: string) => number;
    /** Whether a browser that only reads may serve a chat. */
    readOnlyHost: boolean;
  } = {
    acts: true,
    readOnlyHost: stellaBrowser !== null && !stellaBrowser.acts,
    actsFor: (controllerId) =>
      (chats.get(controllerId) ?? choose())?.acts ?? true,
    request: async (request, signal) => {
      const host = hostFor(request.controllerId, request.command.action);
      if (host === null) {
        return localBrowserResult(
          browserBridgeError(
            BROWSER_CONTROL_ERROR_CODE.disconnected,
            NO_BROWSER,
          ),
        );
      }
      const previous = chats.get(request.controllerId);
      if (
        request.command.action !== BROWSER_CONTROL_ACTION.open ||
        previous === host
      ) {
        return await host.request(request, signal);
      }
      // An open in another browser: the tab the chat watched is the first
      // browser's, and the chat moves only once the page opened there.
      const result = await host.request(
        { ...request, observedTab: null },
        signal,
      );
      if (!openedIn(result)) {
        // Whatever the failed open made there goes with the chat's idle time.
        if (previous !== undefined) {
          host.releaseChat(request.controllerId);
        }
        return result;
      }
      // The chat leaves its tabs in the first browser.
      previous?.releaseChat(request.controllerId);
      chats.set(request.controllerId, host);
      moves.set(
        request.controllerId,
        (moves.get(request.controllerId) ?? 0) + 1,
      );
      return result;
    },
    browserMoves: (controllerId) => moves.get(controllerId) ?? 0,
    cancel: (run) => {
      for (const host of hosts()) {
        host.cancel(run);
      }
    },
    releaseChat: (controllerId) => {
      chats.delete(controllerId);
      for (const host of hosts()) {
        host.releaseChat(controllerId);
      }
    },
  };
  return router;
};

export type HostRouter = ReturnType<typeof createHostRouter>;
