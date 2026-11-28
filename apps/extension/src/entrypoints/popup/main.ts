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
  containedTabRows,
  desktopLineStatus,
  type PopupAction,
  type PopupActiveTab,
  type PopupLineStatus,
  type PopupMessageKey,
  type PopupView,
  popupView,
  websiteLineStatus,
} from "../../lib/popup-view";
import { BROWSER_DESKTOP_LINK_STORAGE_KEY } from "../../lib/storage-keys";
import { containedTabIds, readContainedTabs } from "../../lib/tab-containment";
import { trustedStellaOriginFromUrl } from "../../lib/trusted-origin";

const element = <T extends Element>(selector: string, type: new () => T): T => {
  const found = document.querySelector(selector);
  return found instanceof type
    ? found
    : panic(`Missing popup element ${selector}`);
};

const titleElement = element("#title", HTMLHeadingElement);
const purposeElement = element("#purpose", HTMLParagraphElement);
const noticeElement = element("#notice", HTMLParagraphElement);
const websiteName = element("#website-name", HTMLSpanElement);
const websiteConnect = element("#website-connect", HTMLButtonElement);
const websiteStatus = element("#website-status", HTMLSpanElement);
const websiteStatusText = element("#website-status-text", HTMLSpanElement);
const websiteOrigin = element("#website-origin", HTMLSpanElement);
const desktopName = element("#desktop-name", HTMLSpanElement);
const desktopConnect = element("#desktop-connect", HTMLButtonElement);
const desktopStatus = element("#desktop-status", HTMLSpanElement);
const desktopStatusText = element("#desktop-status-text", HTMLSpanElement);
const containedTabsElement = element("#contained-tabs", HTMLDivElement);
const containedTabsLabel = element("#contained-tabs-label", HTMLSpanElement);
const containedTabList = element("#contained-tab-list", HTMLUListElement);
const adoptButton = element("#adopt", HTMLButtonElement);
const footerElement = element("#footer", HTMLDivElement);

const message = (
  name: PopupMessageKey | "@@bidi_dir",
  substitutions?: string | string[],
): string => chrome.i18n.getMessage(name, substitutions);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.documentElement.dir = message("@@bidi_dir");
document.title = message("extensionName");
titleElement.textContent = message("extensionName");
purposeElement.textContent = message("connectionPurpose");
websiteName.textContent = message("lineWebsite");
desktopName.textContent = message("lineDesktop");
websiteConnect.textContent = message("lineConnect");
desktopConnect.textContent = message("lineConnect");
adoptButton.textContent = message("adoptTab");
containedTabsLabel.textContent = message("usingTabs");

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

/**
 * Shows a line's Connect button, or its status. Both start hidden, so a
 * line never flashes a state it is not in.
 */
const renderLine = (
  line: PopupLineStatus,
  button: HTMLButtonElement,
  status: HTMLSpanElement,
  statusText: HTMLSpanElement,
): void => {
  button.hidden = line.type !== "connect";
  status.hidden = line.type !== "status";
  if (line.type === "status") {
    status.dataset["tone"] = line.tone;
    statusText.textContent = message(line.messageKey);
  } else {
    delete status.dataset["tone"];
    statusText.textContent = "";
  }
  if (line.type === "status" && line.detailKey !== undefined) {
    status.title = message(line.detailKey);
  } else {
    status.removeAttribute("title");
  }
};
let renderedView: PopupView | null = null;

const render = (
  view: PopupView,
  containedTabs: readonly chrome.tabs.Tab[],
): void => {
  renderedView = view;
  renderLine(
    websiteLineStatus(view),
    websiteConnect,
    websiteStatus,
    websiteStatusText,
  );
  // The address is a tooltip on screen and read out to screen readers.
  const origin = view.website.type === "connected" ? view.website.origin : null;
  websiteOrigin.textContent = origin ?? "";
  if (origin === null) {
    websiteStatus.removeAttribute("title");
  } else {
    websiteStatus.title = origin;
  }
  renderContainedTabs(origin === null ? [] : containedTabs);
  adoptButton.hidden = !view.offerTab;
  footerElement.replaceChildren(
    ...view.footer.map((link) => {
      const button = document.createElement("button");
      button.className = "link";
      button.type = "button";
      button.textContent = message(link.messageKey);
      button.addEventListener("click", () =>
        execute(button, { action: link.action }),
      );
      return button;
    }),
  );
};

/**
 * Connects the stella tab in front, or has the worker open or find one and
 * connect it: that brings another tab forward, which closes the popup.
 */
const connectWebsite = async (tabId: number | null): Promise<void> => {
  const result = await sendPopupRequest(
    tabId === null ? { type: "open-and-pair" } : { tabId, type: "pair" },
  );
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
  await renderAccess({ handedTab: true });
};

const execute = (button: HTMLButtonElement, action: PopupAction): void => {
  button.disabled = true;
  runPopupAction(action, {
    requestAccess: requestAllSiteAccess,
    readActiveTab,
    connectWebsite,
    adopt: adoptActiveTab,
    disconnect: async () => {
      await sendPopupRequest({ type: "disconnect" });
    },
    revoke: async () => {
      await sendPopupRequest({ type: "revoke" });
    },
    render: async () => await renderAccess(),
  })
    .catch(() => renderFailure("accessUpdateFailed"))
    .finally(() => {
      button.disabled = false;
    });
};

websiteConnect.addEventListener("click", () => {
  if (renderedView?.website.type === "connect") {
    execute(websiteConnect, renderedView.website.connect);
  }
});

adoptButton.addEventListener("click", () => {
  execute(adoptButton, { action: "adopt" });
});

/** The latest desktop render; an older one that finishes later is dropped. */
let desktopRender = 0;

const renderDesktopLink = async (): Promise<void> => {
  desktopRender += 1;
  const thisRender = desktopRender;
  const [allowed, state] = await Promise.all([
    hasDesktopLinkAccess(),
    readDesktopLinkState(),
  ]);
  if (thisRender !== desktopRender) {
    return;
  }
  renderLine(
    desktopLineStatus({ allowed, state }),
    desktopConnect,
    desktopStatus,
    desktopStatusText,
  );
};

// The link connects and drops while the popup is open.
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.hasOwn(changes, BROWSER_DESKTOP_LINK_STORAGE_KEY)) {
    renderDesktopLink().catch(() => renderFailure("accessUpdateFailed"));
  }
});

desktopConnect.addEventListener("click", () => {
  desktopConnect.disabled = true;
  // Asked for within the click's user gesture, before anything else awaits.
  requestDesktopLinkAccess()
    .then(async () => {
      await renderDesktopLink();
      return undefined;
    })
    .catch(() => renderFailure("accessUpdateFailed"))
    .finally(() => {
      desktopConnect.disabled = false;
    });
});

/** The latest website render; an older one that finishes later is dropped. */
let accessRender = 0;

const renderAccess = async ({
  handedTab = false,
}: { handedTab?: boolean } = {}): Promise<void> => {
  accessRender += 1;
  const thisRender = accessRender;
  const [granted, controller, activeTab, containedTabs] = await Promise.all([
    hasAllSiteAccess(),
    readBrowserController(),
    readActiveTab(),
    readContainedTabsList(),
  ]);
  if (thisRender !== accessRender) {
    return;
  }
  render(
    popupView({
      activeTab: activeTabKind(activeTab),
      controller,
      granted,
      handedTab,
    }),
    containedTabs,
  );
};

const renderAll = async (): Promise<void> => {
  await Promise.all([renderAccess(), renderDesktopLink()]);
};

// Website access also allows stella desktop, and either can be granted or
// removed from Chrome's own settings while the popup is open.
for (const event of [
  chrome.permissions.onAdded,
  chrome.permissions.onRemoved,
]) {
  event.addListener(() => {
    renderAll().catch(() => renderFailure("accessUpdateFailed"));
  });
}

await renderAll();
const taken = await sendPopupRequest({ type: "take-download-notices" });
const downloadNotice =
  taken.status === "download-notices" ? downloadNoticeMessage(taken) : null;
if (downloadNotice !== null) {
  renderNotice(
    chrome.i18n.getMessage(downloadNotice.name, downloadNotice.substitutions),
  );
}
