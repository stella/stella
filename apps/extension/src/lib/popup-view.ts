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
export type PopupAction = {
  action: "adopt" | "connect" | "grant" | "grant-and-connect";
  messageKey: PopupMessageKey;
};
export type PopupSecondaryAction = {
  action: "disconnect" | "revoke";
  /** A plain button, or a quieter text link for the less common action. */
  appearance: "button" | "link";
  messageKey: PopupMessageKey;
};
type PopupState =
  | { type: "connected"; origin: string }
  | { type: "connected-elsewhere" }
  | { type: "not-connected" }
  | { type: "website-access-needed" }
  | { type: "open-stella-to-connect" }
  | { type: "tab-handed-to-stella"; origin: string };
export type PopupView = {
  primary: PopupAction | null;
  secondary: readonly PopupSecondaryAction[];
  /** Whether to say what connecting does; only until stella is connected. */
  showPurpose: boolean;
  state: PopupState;
  statusMessageKey: PopupMessageKey;
};

const DISCONNECT = {
  action: "disconnect",
  appearance: "button",
  messageKey: "disconnectTab",
} as const satisfies PopupSecondaryAction;
const REVOKE = {
  action: "revoke",
  appearance: "link",
  messageKey: "revokeAccess",
} as const satisfies PopupSecondaryAction;

type PopupViewInput = {
  activeTab: PopupActiveTab;
  controller: PopupController | null;
  granted: boolean;
};

/** Returns the complete popup state without reading browser or DOM state. */
export const popupView = ({
  activeTab,
  controller,
  granted,
}: PopupViewInput): PopupView => {
  if (!granted) {
    return {
      primary:
        activeTab.kind === "stella"
          ? { action: "grant-and-connect", messageKey: "allowAndConnect" }
          : { action: "grant", messageKey: "allowWebsiteAccess" },
      secondary: controller === null ? [] : [DISCONNECT],
      showPurpose: true,
      state: { type: "website-access-needed" },
      statusMessageKey: "statusWebsiteAccessNeeded",
    };
  }
  if (controller === null) {
    if (activeTab.kind === "stella") {
      return {
        primary: { action: "connect", messageKey: "connectStella" },
        secondary: [REVOKE],
        showPurpose: true,
        state: { type: "not-connected" },
        statusMessageKey: "statusNotConnected",
      };
    }
    return {
      primary: null,
      secondary: [REVOKE],
      showPurpose: true,
      state: { type: "open-stella-to-connect" },
      statusMessageKey: "statusOpenStella",
    };
  }
  // One connection covers every stella tab on its origin.
  if (activeTab.kind === "stella" && activeTab.origin !== controller.origin) {
    return {
      primary: { action: "connect", messageKey: "connectStellaInstead" },
      secondary: [DISCONNECT, REVOKE],
      showPurpose: false,
      state: { type: "connected-elsewhere" },
      statusMessageKey: "statusConnectedElsewhere",
    };
  }
  return {
    primary:
      activeTab.kind === "controllable"
        ? { action: "adopt", messageKey: "adoptTab" }
        : null,
    secondary: [DISCONNECT, REVOKE],
    showPurpose: false,
    state: { origin: controller.origin, type: "connected" },
    statusMessageKey: "statusConnected",
  };
};

/** The view right after the user hands a tab over; `origin` is stella's. */
export const handedTabView = (origin: string): PopupView => ({
  primary: null,
  secondary: [DISCONNECT, REVOKE],
  showPurpose: false,
  state: { origin, type: "tab-handed-to-stella" },
  statusMessageKey: "statusConnected",
});

/**
 * The address stella is connected at, shown as the status tooltip and read
 * out to screen readers; null while not connected here.
 */
export const connectedOrigin = ({ state }: PopupView): string | null => {
  switch (state.type) {
    case "connected":
    case "tab-handed-to-stella":
      return state.origin;
    case "connected-elsewhere":
    case "not-connected":
    case "open-stella-to-connect":
    case "website-access-needed":
      return null;
    default:
      state satisfies never;
      return panic("Unhandled popup state");
  }
};

/**
 * The popup's stella desktop row: a button that asks Chrome to let the
 * extension talk to stella desktop, or, once allowed, whether stella
 * desktop answers.
 */
export type DesktopLinkView = {
  messageKey: PopupMessageKey;
  type: "allow" | "connected" | "not-running" | "update-needed";
};

export const desktopLinkView = ({
  allowed,
  state,
}: {
  allowed: boolean;
  state: DesktopLinkState;
}): DesktopLinkView => {
  if (!allowed) {
    return { messageKey: "allowDesktop", type: "allow" };
  }
  switch (state) {
    case DESKTOP_LINK_STATE.connected:
      return { messageKey: "desktopConnected", type: "connected" };
    case DESKTOP_LINK_STATE.incompatible:
      return { messageKey: "desktopUpdateNeeded", type: "update-needed" };
    // The host waits for stella desktop until it answers.
    case DESKTOP_LINK_STATE.offline:
    case DESKTOP_LINK_STATE.waiting:
      return { messageKey: "desktopNotRunning", type: "not-running" };
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
