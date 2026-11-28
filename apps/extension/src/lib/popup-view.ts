import { panic } from "better-result";

import type enMessages from "../../public/_locales/en/messages.json";
import type { BrowserController } from "./controller";
import { DESKTOP_LINK_STATE, type DesktopLinkState } from "./desktop-link";

export type PopupMessageKey = keyof typeof enMessages;
export type PopupActiveTab =
  | { kind: "stella"; origin: string; tabId: number }
  | { kind: "controllable" }
  | { kind: "unsupported" };
export type PopupController = Pick<BrowserController, "origin">;

/**
 * Connecting the stella website, all in one click: website access first
 * when Chrome has not granted it, then the stella tab in front, or else a
 * stella tab opened or brought forward.
 */
type ConnectWebsiteAction = {
  action: "connect-website";
  askAccess: boolean;
  /** The stella tab in front to connect; null opens or finds one. */
  tabId: number | null;
};
export type PopupAction =
  ConnectWebsiteAction | { action: "adopt" | "disconnect" | "revoke" };

/** A line's state: a button to click, or a dot and a word. */
export type PopupLineStatus =
  | { type: "connect" }
  | {
      /** The longer explanation, shown as a tooltip. */
      detailKey?: PopupMessageKey;
      messageKey: PopupMessageKey;
      tone: "connected" | "idle" | "warning";
      type: "status";
    };

/** The quiet links at the bottom of the popup. */
type PopupFooterAction = {
  action: "disconnect" | "revoke";
  messageKey: PopupMessageKey;
};

export type PopupWebsiteView =
  | { connect: ConnectWebsiteAction; type: "connect" }
  | { origin: string; type: "connected" };

export type PopupView = {
  footer: readonly PopupFooterAction[];
  /** Hand the tab in front to stella: only while connected, on a normal site. */
  offerTab: boolean;
  website: PopupWebsiteView;
};

const DISCONNECT = {
  action: "disconnect",
  messageKey: "disconnectTab",
} as const satisfies PopupFooterAction;
const REVOKE = {
  action: "revoke",
  messageKey: "revokeAccess",
} as const satisfies PopupFooterAction;

type PopupViewInput = {
  activeTab: PopupActiveTab;
  controller: PopupController | null;
  granted: boolean;
  /** The user just handed the tab in front to stella. */
  handedTab?: boolean;
};

/** Returns the complete popup state without reading browser or DOM state. */
export const popupView = ({
  activeTab,
  controller,
  granted,
  handedTab = false,
}: PopupViewInput): PopupView => {
  const footer = [
    ...(controller === null ? [] : [DISCONNECT]),
    ...(granted ? [REVOKE] : []),
  ];
  // One connection covers every stella tab on its origin; a stella tab on
  // another origin is not connected until the user connects it instead.
  const connected =
    granted &&
    controller !== null &&
    (activeTab.kind !== "stella" || activeTab.origin === controller.origin);
  if (!connected) {
    return {
      footer,
      offerTab: false,
      website: {
        connect: {
          action: "connect-website",
          askAccess: !granted,
          tabId: activeTab.kind === "stella" ? activeTab.tabId : null,
        },
        type: "connect",
      },
    };
  }
  return {
    footer,
    offerTab: activeTab.kind === "controllable" && !handedTab,
    website: { origin: controller.origin, type: "connected" },
  };
};

const CONNECTED = {
  messageKey: "statusConnected",
  tone: "connected",
  type: "status",
} as const satisfies PopupLineStatus;

/** The website line: Connected, or the Connect button. */
export const websiteLineStatus = ({ website }: PopupView): PopupLineStatus =>
  website.type === "connected" ? CONNECTED : { type: "connect" };

/**
 * The stella desktop app line: the Connect button that asks Chrome to let
 * the extension talk to the app, or, once allowed, whether the app answers.
 * Nothing is clickable once allowed: the extension connects by itself as
 * soon as the app runs.
 */
export const desktopLineStatus = ({
  allowed,
  state,
}: {
  allowed: boolean;
  state: DesktopLinkState;
}): PopupLineStatus => {
  if (!allowed) {
    return { type: "connect" };
  }
  switch (state) {
    case DESKTOP_LINK_STATE.connected:
      return CONNECTED;
    case DESKTOP_LINK_STATE.incompatible:
      // Either side may be the older one; the app usually is, as Chrome
      // keeps the extension up to date.
      return {
        detailKey: "desktopUpdateNeeded",
        messageKey: "lineUpdateApp",
        tone: "warning",
        type: "status",
      };
    case DESKTOP_LINK_STATE.waiting:
      return { messageKey: "lineConnecting", tone: "idle", type: "status" };
    case DESKTOP_LINK_STATE.offline:
      return { messageKey: "lineOpenApp", tone: "idle", type: "status" };
    default:
      state satisfies never;
      return panic("Unhandled desktop link state");
  }
};

type NamedTab = Pick<chrome.tabs.Tab, "title" | "url">;

/** One tab stella keeps contained, as the popup lists it. */
export type ContainedTabRow = {
  /** The tab's host, unless the name already is the host. */
  host: string | null;
  /** The tab's title, or its host when it has none. */
  name: string;
};

const webHost = (rawUrl: string | undefined): string | null => {
  if (rawUrl === undefined) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.host
      : null;
  } catch {
    return null;
  }
};

/**
 * The tabs stella keeps contained, which stay so until stella is
 * disconnected or they close, named so the user can find them among their
 * tabs: by title and host, or whichever Chrome reported. A tab Chrome
 * reported neither for is left out.
 */
export const containedTabRows = (
  tabs: readonly NamedTab[],
): ContainedTabRow[] =>
  tabs.flatMap(({ title, url }): ContainedTabRow[] => {
    const trimmed = title?.trim() ?? "";
    const host = webHost(url);
    if (trimmed === "") {
      return host === null ? [] : [{ host: null, name: host }];
    }
    return [{ host: trimmed === host ? null : host, name: trimmed }];
  });
