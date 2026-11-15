import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
} from "@stll/api-contract/browser-control";

import { type BrowserBridge, browserBridgeError } from "./bridge";
import type { BrowserHost, BrowserHostRequest } from "./browser-host";
import { localBrowserResult } from "./local-result";

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

const NO_BROWSER =
  "stella cannot reach a browser on this computer. Ask the member to open Chrome with the stella extension and choose Use with stella desktop, then try again.";

export const createHostRouter = ({
  extension,
  stellaBrowser,
}: HostRouterOptions) => {
  /** The host each chat's last `open` went to. */
  const chats = new Map<string, BrowserHost>();

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
      if (request.command.action === BROWSER_CONTROL_ACTION.open) {
        // A chat that moves to another browser leaves its tabs in the first.
        const previous = chats.get(request.controllerId);
        if (previous !== undefined && previous !== host) {
          previous.releaseChat(request.controllerId);
        }
        chats.set(request.controllerId, host);
      }
      return await host.request(request, signal);
    },
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
