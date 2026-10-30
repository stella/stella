import { panic } from "better-result";

import { hasAllSiteAccess, requestAllSiteAccess } from "../../lib/access";
import { readBrowserController } from "../../lib/controller";
import { downloadNoticeMessage } from "../../lib/download-guard";
import { parseControllableUrl } from "../../lib/origin-policy";
import { runPopupAction } from "../../lib/popup-actions";
import { type PopupResponse, sendPopupRequest } from "../../lib/popup-request";
import {
  handedTabView,
  type PopupAction,
  type PopupActiveTab,
  type PopupMessageKey,
  type PopupSecondaryAction,
  type PopupView,
  popupView,
} from "../../lib/popup-view";
import { trustedStellaOriginFromUrl } from "../../lib/trusted-origin";

const purposeElement = document.querySelector("#purpose");
const statusElement = document.querySelector("#status");
const statusLine = document.querySelector(".status-line");
const primaryButton = document.querySelector("#primary");
const secondaryActions = document.querySelector("#secondary-actions");
const titleElement = document.querySelector("#title");

if (!(purposeElement instanceof HTMLParagraphElement)) {
  panic("Missing popup purpose element");
}
if (!(statusElement instanceof HTMLParagraphElement)) {
  panic("Missing popup status element");
}
if (!(statusLine instanceof HTMLDivElement)) {
  panic("Missing popup status line");
}
if (!(primaryButton instanceof HTMLButtonElement)) {
  panic("Missing popup primary button");
}
if (!(secondaryActions instanceof HTMLDivElement)) {
  panic("Missing popup secondary actions");
}
if (!(titleElement instanceof HTMLHeadingElement)) {
  panic("Missing popup title element");
}

const message = (
  name: PopupMessageKey | "@@bidi_dir",
  substitutions?: string | string[],
): string => chrome.i18n.getMessage(name, substitutions);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.documentElement.dir = message("@@bidi_dir");
document.title = message("extensionName");
titleElement.textContent = message("extensionName");
purposeElement.textContent = message("connectionPurpose");
statusElement.textContent = message("checkingAccess");

const readActiveTab = async (): Promise<chrome.tabs.Tab | null> =>
  (await chrome.tabs.query({ active: true, currentWindow: true })).at(0) ??
  null;

const activeTabKind = (tab: chrome.tabs.Tab | null): PopupActiveTab => {
  const url = tab?.url ?? "";
  if (trustedStellaOriginFromUrl(url) !== null) {
    return tab?.id === undefined
      ? { kind: "unsupported" }
      : { kind: "stella", tabId: tab.id };
  }
  if (parseControllableUrl(url) !== null) {
    return { kind: "controllable" };
  }
  return { kind: "unsupported" };
};

const statusSubstitutions = (view: PopupView): string[] | undefined => {
  switch (view.state.type) {
    case "connected":
    case "tab-handed-to-stella":
      return [view.state.origin];
    case "connected-elsewhere":
    case "not-connected":
    case "open-stella-to-connect":
    case "website-access-needed":
      return undefined;
    default:
      view.state satisfies never;
      return panic("Unhandled popup state");
  }
};

const renderFailure = (key: PopupMessageKey): void => {
  statusElement.textContent = message(key);
};

const renderSecondaryAction = (
  action: PopupSecondaryAction,
): HTMLDivElement => {
  const wrapper = document.createElement("div");
  wrapper.className = "secondary-action";
  const button = document.createElement("button");
  button.className = "secondary";
  button.type = "button";
  button.textContent = message(action.messageKey);
  const description = document.createElement("p");
  description.textContent = message(action.descriptionMessageKey);
  button.addEventListener("click", () => execute(button, action.action));
  wrapper.append(button, description);
  return wrapper;
};

const render = (view: PopupView): void => {
  statusLine.dataset["state"] = view.state.type;
  statusElement.textContent = message(
    view.statusMessageKey,
    statusSubstitutions(view),
  );
  primaryButton.hidden = view.primary === null;
  if (view.primary !== null) {
    primaryButton.textContent = message(view.primary.messageKey);
    primaryButton.dataset["action"] = view.primary.action;
  } else {
    delete primaryButton.dataset["action"];
  }
  secondaryActions.replaceChildren(
    ...view.secondary.map(renderSecondaryAction),
  );
};

const pairActiveTab = async (
  activeTab: chrome.tabs.Tab | null,
): Promise<void> => {
  const result =
    activeTab?.id === undefined
      ? ({ status: "unsupported-tab" } as const)
      : await sendPopupRequest({ tabId: activeTab.id, type: "pair" });
  if (result.status !== "done") {
    renderFailure(
      result.status === "failed" ? "accessUpdateFailed" : "unsupportedTab",
    );
    return;
  }
  await renderAccess();
};

const adoptFailureMessage = {
  done: "unsupportedTab",
  "download-notices": "accessUpdateFailed",
  failed: "accessUpdateFailed",
  "unsupported-page": "adoptUnsupported",
  "unsupported-tab": "unsupportedTab",
} as const satisfies Record<
  Exclude<PopupResponse["status"], "adopted">,
  PopupMessageKey
>;

const adoptActiveTab = async (
  activeTab: chrome.tabs.Tab | null,
): Promise<void> => {
  if (activeTab?.id === undefined) {
    renderFailure("unsupportedTab");
    return;
  }
  const result = await sendPopupRequest({ tabId: activeTab.id, type: "adopt" });
  if (result.status !== "adopted") {
    renderFailure(adoptFailureMessage[result.status]);
    return;
  }
  render(handedTabView(new URL(result.url).origin));
};

const execute = (
  button: HTMLButtonElement,
  action: PopupAction["action"] | PopupSecondaryAction["action"],
): void => {
  button.disabled = true;
  runPopupAction(action, {
    renderedTab,
    requestAccess: requestAllSiteAccess,
    readActiveTab,
    pair: pairActiveTab,
    adopt: adoptActiveTab,
    disconnect: async () => {
      await sendPopupRequest({ type: "disconnect" });
    },
    revoke: async () => {
      await sendPopupRequest({ type: "revoke" });
    },
    render: renderAccess,
  })
    .catch(() => renderFailure("accessUpdateFailed"))
    .finally(() => {
      button.disabled = false;
    });
};

primaryButton.addEventListener("click", () => {
  const action = primaryButton.dataset["action"];
  if (
    action === "adopt" ||
    action === "connect" ||
    action === "grant" ||
    action === "grant-and-connect"
  ) {
    execute(primaryButton, action);
  }
});

let renderedTab: chrome.tabs.Tab | null = null;

const renderAccess = async (): Promise<void> => {
  const [granted, controller, activeTab] = await Promise.all([
    hasAllSiteAccess(),
    readBrowserController(),
    readActiveTab(),
  ]);
  renderedTab = activeTab;
  render(
    popupView({ activeTab: activeTabKind(activeTab), controller, granted }),
  );
};

await renderAccess();
const taken = await sendPopupRequest({ type: "take-download-notices" });
const downloadNotice =
  taken.status === "download-notices" ? downloadNoticeMessage(taken) : null;
if (downloadNotice !== null) {
  statusElement.textContent = chrome.i18n.getMessage(
    downloadNotice.name,
    downloadNotice.substitutions,
  );
}
