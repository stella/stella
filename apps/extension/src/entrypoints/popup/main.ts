import { panic } from "better-result";

import { hasAllSiteAccess, requestAllSiteAccess } from "../../lib/access";
import { readBrowserController } from "../../lib/controller";
import { downloadNoticeMessage } from "../../lib/download-guard";
import { parseControllableUrl } from "../../lib/origin-policy";
import { type PopupResponse, sendPopupRequest } from "../../lib/popup-request";
import { trustedStellaOriginFromUrl } from "../../lib/trusted-origin";

const statusElement = document.querySelector("#status");
const grantButton = document.querySelector("#grant");
const connectButton = document.querySelector("#connect");
const adoptButton = document.querySelector("#adopt");
const disconnectButton = document.querySelector("#disconnect");
const revokeButton = document.querySelector("#revoke");
const titleElement = document.querySelector("#title");

if (!(statusElement instanceof HTMLParagraphElement)) {
  panic("Missing popup status element");
}
if (!(grantButton instanceof HTMLButtonElement)) {
  panic("Missing popup grant button");
}
if (!(connectButton instanceof HTMLButtonElement)) {
  panic("Missing popup connect button");
}
if (!(adoptButton instanceof HTMLButtonElement)) {
  panic("Missing popup adopt button");
}
if (!(disconnectButton instanceof HTMLButtonElement)) {
  panic("Missing popup disconnect button");
}
if (!(revokeButton instanceof HTMLButtonElement)) {
  panic("Missing popup revoke button");
}
if (!(titleElement instanceof HTMLHeadingElement)) {
  panic("Missing popup title element");
}

const message = (name: string, substitutions?: string | string[]): string =>
  chrome.i18n.getMessage(name, substitutions);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.documentElement.dir = message("@@bidi_dir");
document.title = message("extensionName");
titleElement.textContent = message("extensionName");
grantButton.textContent = message("grantAccess");
connectButton.textContent = message("connectTab");
adoptButton.textContent = message("adoptTab");
disconnectButton.textContent = message("disconnectTab");
revokeButton.textContent = message("revokeAccess");
statusElement.textContent = message("checkingAccess");

const readActiveTab = async (): Promise<chrome.tabs.Tab | null> =>
  (await chrome.tabs.query({ active: true, currentWindow: true })).at(0) ??
  null;

/**
 * The popup shows one primary action for the tab it was opened on: connect a
 * stella tab as the controller, or hand any other public HTTPS page to a
 * connected controller so chat can read it in place.
 */
const renderAccess = async (): Promise<void> => {
  const [granted, controller, activeTab] = await Promise.all([
    hasAllSiteAccess(),
    readBrowserController(),
    readActiveTab(),
  ]);
  const activeUrl = activeTab?.url ?? "";
  const onStellaTab = trustedStellaOriginFromUrl(activeUrl) !== null;
  const onControllablePage = parseControllableUrl(activeUrl) !== null;

  if (!granted) {
    statusElement.textContent = message("accessOff");
  } else if (controller) {
    statusElement.textContent = message("controllerReady", controller.origin);
  } else {
    statusElement.textContent = message("accessReady");
  }
  grantButton.hidden = granted;
  connectButton.hidden = !granted || !onStellaTab;
  // A stella tab is the controller, never the page chat operates on.
  adoptButton.hidden =
    !granted || controller === null || onStellaTab || !onControllablePage;
  disconnectButton.hidden = controller === null;
  revokeButton.hidden = !granted;
};

grantButton.addEventListener("click", () => {
  requestAllSiteAccess()
    .then(async (granted) => {
      if (!granted) {
        statusElement.textContent = message("accessUpdateFailed");
        return undefined;
      }
      await renderAccess();
      return undefined;
    })
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      grantButton.disabled = false;
    });
  grantButton.disabled = true;
});

const adoptFailureMessage = {
  done: "unsupportedTab",
  "download-notices": "accessUpdateFailed",
  failed: "accessUpdateFailed",
  "unsupported-page": "adoptUnsupported",
  "unsupported-tab": "unsupportedTab",
} as const satisfies Record<
  Exclude<PopupResponse["status"], "adopted">,
  string
>;

// Pairing, adopting, disconnecting and revoking are changes the worker
// makes, in order with the browser commands they must not race.
connectButton.addEventListener("click", () => {
  connectButton.disabled = true;
  readActiveTab()
    .then(async (activeTab) => {
      const result =
        activeTab?.id === undefined
          ? ({ status: "unsupported-tab" } as const)
          : await sendPopupRequest({ tabId: activeTab.id, type: "pair" });
      if (result.status !== "done") {
        statusElement.textContent = message(
          result.status === "failed" ? "accessUpdateFailed" : "unsupportedTab",
        );
        return undefined;
      }
      await renderAccess();
      return undefined;
    })
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      connectButton.disabled = false;
    });
});

adoptButton.addEventListener("click", () => {
  adoptButton.disabled = true;
  readActiveTab()
    .then(async (activeTab) => {
      if (activeTab?.id === undefined) {
        statusElement.textContent = message("unsupportedTab");
        return undefined;
      }
      const result = await sendPopupRequest({
        tabId: activeTab.id,
        type: "adopt",
      });
      if (result.status !== "adopted") {
        statusElement.textContent = message(adoptFailureMessage[result.status]);
        return undefined;
      }
      statusElement.textContent = message(
        "adoptedTab",
        new URL(result.url).origin,
      );
      return undefined;
    })
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      adoptButton.disabled = false;
    });
});

disconnectButton.addEventListener("click", () => {
  disconnectButton.disabled = true;
  sendPopupRequest({ type: "disconnect" })
    .then(renderAccess)
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      disconnectButton.disabled = false;
    });
});

revokeButton.addEventListener("click", () => {
  revokeButton.disabled = true;
  sendPopupRequest({ type: "revoke" })
    .then(renderAccess)
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      revokeButton.disabled = false;
    });
});

await renderAccess();
// Downloads stopped or kept while stella controlled a tab are shown once,
// here; a kept file is always named, since it is on disk.
// The worker owns the notices: it hands them over and clears them in turn
// with any download it is recording.
const taken = await sendPopupRequest({ type: "take-download-notices" });
const downloadNotice =
  taken.status === "download-notices" ? downloadNoticeMessage(taken) : null;
if (downloadNotice !== null) {
  statusElement.textContent = message(
    downloadNotice.name,
    downloadNotice.substitutions,
  );
}
