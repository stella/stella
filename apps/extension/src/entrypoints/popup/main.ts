import { panic } from "better-result";

import {
  hasAllSiteAccess,
  hasDesktopLinkAccess,
  requestAllSiteAccess,
  requestDesktopLinkAccess,
} from "../../lib/access";
import { readBrowserController } from "../../lib/controller";
import { readDesktopLinkState } from "../../lib/desktop-link";
import { downloadNoticeMessage } from "../../lib/download-guard";
import { parseControllableUrl } from "../../lib/origin-policy";
import { type PopupTab, runPopupAction } from "../../lib/popup-actions";
import { type PopupResponse, sendPopupRequest } from "../../lib/popup-request";
import {
  connectedOrigin,
  containedTabRows,
  desktopLinkView,
  handedTabView,
  type PopupAction,
  type PopupActiveTab,
  type PopupMessageKey,
  type PopupSecondaryAction,
  type PopupView,
  popupView,
} from "../../lib/popup-view";
import { containedTabIds, readContainedTabs } from "../../lib/tab-containment";
import { trustedStellaOriginFromUrl } from "../../lib/trusted-origin";

const element = <T extends Element>(selector: string, type: new () => T): T => {
  const found = document.querySelector(selector);
  return found instanceof type
    ? found
    : panic(`Missing popup element ${selector}`);
};

const titleElement = element("#title", HTMLHeadingElement);
const statusElement = element("#status", HTMLParagraphElement);
const statusText = element("#status-text", HTMLSpanElement);
const statusOrigin = element("#status-origin", HTMLSpanElement);
const purposeElement = element("#purpose", HTMLParagraphElement);
const noticeElement = element("#notice", HTMLParagraphElement);
const containedTabsElement = element("#contained-tabs", HTMLDivElement);
const containedTabsLabel = element("#contained-tabs-label", HTMLSpanElement);
const containedTabList = element("#contained-tab-list", HTMLUListElement);
const primaryButton = element("#primary", HTMLButtonElement);
const secondaryActions = element("#secondary-actions", HTMLDivElement);
const desktopStatus = element("#desktop-status", HTMLParagraphElement);
const desktopStatusText = element("#desktop-status-text", HTMLSpanElement);
const desktopAllowButton = element("#desktop-allow", HTMLButtonElement);

const message = (
  name: PopupMessageKey | "@@bidi_dir",
  substitutions?: string | string[],
): string => chrome.i18n.getMessage(name, substitutions);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.documentElement.dir = message("@@bidi_dir");
document.title = message("extensionName");
titleElement.textContent = message("extensionName");
purposeElement.textContent = message("connectionPurpose");
containedTabsLabel.textContent = message("usingTabs");
statusText.textContent = message("checkingAccess");

const readActiveTab = async (): Promise<PopupTab | null> =>
  (await chrome.tabs.query({ active: true, currentWindow: true })).at(0) ??
  null;

const activeTabKind = (tab: PopupTab | null): PopupActiveTab => {
  const url = tab?.url ?? "";
  const stellaOrigin = trustedStellaOriginFromUrl(url);
  if (stellaOrigin !== null) {
    return tab?.id !== undefined
      ? { kind: "stella", origin: stellaOrigin, tabId: tab.id }
      : { kind: "unsupported" };
  }
  if (parseControllableUrl(url) !== null) {
    return { kind: "controllable" };
  }
  return { kind: "unsupported" };
};

/** The tabs stella keeps contained: the controlled one first. */
const readContainedTabsList = async (): Promise<chrome.tabs.Tab[]> => {
  const tabIds = containedTabIds(await readContainedTabs());
  const tabs = await Promise.all(
    tabIds.map(async (tabId) => await chrome.tabs.get(tabId).catch(() => null)),
  );
  return tabs.filter((tab) => tab !== null);
};

const renderContainedTabs = (tabs: readonly chrome.tabs.Tab[]): void => {
  const rows = containedTabRows(tabs);
  containedTabsElement.hidden = rows.length === 0;
  containedTabList.replaceChildren(
    ...rows.map(({ host, name }) => {
      const item = document.createElement("li");
      const nameElement = document.createElement("span");
      nameElement.className = "tab-name";
      nameElement.textContent = name;
      nameElement.title = name;
      item.append(nameElement);
      if (host !== null) {
        const hostElement = document.createElement("span");
        hostElement.className = "tab-host";
        hostElement.textContent = host;
        item.append(hostElement);
      }
      return item;
    }),
  );
};

const renderNotice = (text: string): void => {
  noticeElement.textContent = text;
  noticeElement.hidden = false;
};

const renderFailure = (key: PopupMessageKey): void => {
  renderNotice(message(key));
};

const renderSecondaryAction = (
  action: PopupSecondaryAction,
): HTMLButtonElement => {
  const button = document.createElement("button");
  button.className = action.appearance === "link" ? "link" : "secondary";
  button.type = "button";
  button.textContent = message(action.messageKey);
  button.addEventListener("click", () => execute(button, action.action));
  return button;
};

const render = (
  view: PopupView,
  containedTabs: readonly chrome.tabs.Tab[],
): void => {
  statusElement.dataset["state"] = view.state.type;
  statusText.textContent = message(view.statusMessageKey);
  // The address is a tooltip on screen and read out to screen readers.
  const origin = connectedOrigin(view);
  statusOrigin.textContent = origin ?? "";
  if (origin === null) {
    statusElement.removeAttribute("title");
  } else {
    statusElement.title = origin;
  }
  purposeElement.hidden = !view.showPurpose;
  renderContainedTabs(origin === null ? [] : containedTabs);
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

const pairActiveTab = async (activeTab: PopupTab | null): Promise<void> => {
  const result =
    activeTab?.id !== undefined
      ? await sendPopupRequest({ tabId: activeTab.id, type: "pair" })
      : ({ status: "unsupported-tab" } as const);
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

const adoptActiveTab = async (activeTab: PopupTab | null): Promise<void> => {
  const tabId = activeTab === null ? undefined : activeTab.id;
  if (tabId === undefined) {
    renderFailure("unsupportedTab");
    return;
  }
  const result = await sendPopupRequest({ tabId, type: "adopt" });
  if (result.status !== "adopted") {
    renderFailure(adoptFailureMessage[result.status]);
    return;
  }
  const [controller, containedTabs] = await Promise.all([
    readBrowserController(),
    readContainedTabsList(),
  ]);
  if (controller === null) {
    await renderAccess();
    return;
  }
  render(handedTabView(controller.origin), containedTabs);
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

const renderDesktopLink = async (): Promise<void> => {
  const [allowed, state] = await Promise.all([
    hasDesktopLinkAccess(),
    readDesktopLinkState(),
  ]);
  const view = desktopLinkView({ allowed, state });
  desktopAllowButton.hidden = view.type !== "allow";
  desktopStatus.hidden = view.type === "allow";
  desktopStatus.dataset["state"] = view.type;
  const text = message(view.messageKey);
  desktopAllowButton.textContent = view.type === "allow" ? text : "";
  desktopStatusText.textContent = view.type === "allow" ? "" : text;
};

desktopAllowButton.addEventListener("click", () => {
  desktopAllowButton.disabled = true;
  // Asked for within the click's user gesture, before anything else awaits.
  requestDesktopLinkAccess()
    .then(async () => {
      await renderDesktopLink();
      return undefined;
    })
    .catch(() => renderFailure("accessUpdateFailed"))
    .finally(() => {
      desktopAllowButton.disabled = false;
    });
});

let renderedTab: PopupTab | null = null;

const renderAccess = async (): Promise<void> => {
  const [granted, controller, activeTab, containedTabs] = await Promise.all([
    hasAllSiteAccess(),
    readBrowserController(),
    readActiveTab(),
    readContainedTabsList(),
  ]);
  renderedTab = activeTab;
  render(
    popupView({ activeTab: activeTabKind(activeTab), controller, granted }),
    containedTabs,
  );
};

await Promise.all([renderAccess(), renderDesktopLink()]);
const taken = await sendPopupRequest({ type: "take-download-notices" });
const downloadNotice =
  taken.status === "download-notices" ? downloadNoticeMessage(taken) : null;
if (downloadNotice !== null) {
  renderNotice(
    chrome.i18n.getMessage(downloadNotice.name, downloadNotice.substitutions),
  );
}
