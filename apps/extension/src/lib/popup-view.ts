import type enMessages from "../../public/_locales/en/messages.json";
import type { BrowserController } from "./controller";

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
  descriptionMessageKey: PopupMessageKey;
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
  state: PopupState;
  statusMessageKey: PopupMessageKey;
};

const DISCONNECT = {
  action: "disconnect",
  descriptionMessageKey: "disconnectDescription",
  messageKey: "disconnectTab",
} as const satisfies PopupSecondaryAction;
const REVOKE = {
  action: "revoke",
  descriptionMessageKey: "revokeDescription",
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
      state: { type: "website-access-needed" },
      statusMessageKey: "statusWebsiteAccessNeeded",
    };
  }
  if (controller === null) {
    if (activeTab.kind === "stella") {
      return {
        primary: { action: "connect", messageKey: "connectStella" },
        secondary: [REVOKE],
        state: { type: "not-connected" },
        statusMessageKey: "statusNotConnected",
      };
    }
    return {
      primary: null,
      secondary: [REVOKE],
      state: { type: "open-stella-to-connect" },
      statusMessageKey: "statusOpenStella",
    };
  }
  // One connection covers every stella tab on its origin.
  if (activeTab.kind === "stella" && activeTab.origin !== controller.origin) {
    return {
      primary: { action: "connect", messageKey: "connectStellaInstead" },
      secondary: [DISCONNECT, REVOKE],
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
    state: { origin: controller.origin, type: "connected" },
    statusMessageKey: "statusConnected",
  };
};

export const handedTabView = (origin: string): PopupView => ({
  primary: null,
  secondary: [DISCONNECT, REVOKE],
  state: { origin, type: "tab-handed-to-stella" },
  statusMessageKey: "statusTabHandedOver",
});

type NamedTab = Pick<chrome.tabs.Tab, "title" | "url">;

/** Long titles are cut so the popup line stays readable. */
const TAB_TITLE_LIMIT = 60;

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

const shortTitle = (title: string | undefined): string | null => {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  // Cut by grapheme, so an emoji or an accented letter is never split.
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed),
    ({ segment }) => segment,
  );
  return graphemes.length > TAB_TITLE_LIMIT
    ? `${graphemes
        .slice(0, TAB_TITLE_LIMIT - 1)
        .join("")
        .trimEnd()}…`
    : trimmed;
};

/**
 * How the popup names a tab stella keeps contained, so the user can find it
 * among their tabs: its title and host, or whichever Chrome reported. Null
 * when it reported neither.
 */
const containedTabLabel = ({ title, url }: NamedTab): string | null => {
  const name = shortTitle(title);
  const host = webHost(url);
  if (name !== null && host !== null) {
    return name === host ? host : `${name} (${host})`;
  }
  return name ?? host;
};

/**
 * The popup line naming the tabs stella keeps contained, which stay so
 * until stella is disconnected or they close; null when there are none.
 */
export const containedTabsMessage = (
  tabs: readonly NamedTab[],
  locale: string,
): { name: PopupMessageKey; substitutions: string[] } | null => {
  const labels = tabs.map(containedTabLabel).filter((label) => label !== null);
  if (labels.length === 0) {
    return null;
  }
  return {
    name: "containedTabs",
    substitutions: [
      new Intl.ListFormat(locale, { type: "conjunction" }).format(labels),
    ],
  };
};
