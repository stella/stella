import type enMessages from "../../public/_locales/en/messages.json";
import type { BrowserController } from "./controller";

export type PopupMessageKey = keyof typeof enMessages;
export type PopupActiveTab =
  | { kind: "stella"; tabId: number }
  | { kind: "controllable" }
  | { kind: "unsupported" };
export type PopupController = Pick<BrowserController, "origin" | "tabId">;
export type PopupAction = {
  action: "adopt" | "connect" | "grant" | "grant-and-connect";
  messageKey: PopupMessageKey;
};
export type PopupSecondaryAction = {
  action: "disconnect" | "revoke";
  descriptionMessageKey: PopupMessageKey;
  messageKey: PopupMessageKey;
};
export type PopupState =
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
        primary: { action: "connect", messageKey: "connectTab" },
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
  if (activeTab.kind === "stella" && activeTab.tabId !== controller.tabId) {
    return {
      primary: { action: "connect", messageKey: "connectTabInstead" },
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
