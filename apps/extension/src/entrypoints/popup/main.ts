import {
  hasAllSiteAccess,
  removeAllSiteAccess,
  requestAllSiteAccess,
} from "../../lib/access";
import {
  disconnectBrowserController,
  pairActiveStellaTab,
  readBrowserController,
} from "../../lib/controller";
import { parseControllableUrl } from "../../lib/origin-policy";
import { adoptControlledTab } from "../../lib/tab-executor";
import { trustedStellaOriginFromUrl } from "../../lib/trusted-origin";

const statusElement = document.querySelector("#status");
const grantButton = document.querySelector("#grant");
const connectButton = document.querySelector("#connect");
const adoptButton = document.querySelector("#adopt");
const disconnectButton = document.querySelector("#disconnect");
const revokeButton = document.querySelector("#revoke");
const titleElement = document.querySelector("#title");

if (!(statusElement instanceof HTMLParagraphElement)) {
  throw new TypeError("Missing popup status element");
}
if (!(grantButton instanceof HTMLButtonElement)) {
  throw new TypeError("Missing popup grant button");
}
if (!(connectButton instanceof HTMLButtonElement)) {
  throw new TypeError("Missing popup connect button");
}
if (!(adoptButton instanceof HTMLButtonElement)) {
  throw new TypeError("Missing popup adopt button");
}
if (!(disconnectButton instanceof HTMLButtonElement)) {
  throw new TypeError("Missing popup disconnect button");
}
if (!(revokeButton instanceof HTMLButtonElement)) {
  throw new TypeError("Missing popup revoke button");
}
if (!(titleElement instanceof HTMLHeadingElement)) {
  throw new TypeError("Missing popup title element");
}

const message = (name: string, substitution?: string): string =>
  chrome.i18n.getMessage(name, substitution);

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
 * stella tab as the controller, or hand any public HTTPS page to a connected
 * controller so chat can read it in place.
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
  adoptButton.hidden = !granted || controller === null || !onControllablePage;
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

connectButton.addEventListener("click", () => {
  connectButton.disabled = true;
  pairActiveStellaTab()
    .then(async (result) => {
      if (result.status === "unsupported-tab") {
        statusElement.textContent = message("unsupportedTab");
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
  Promise.all([readBrowserController(), readActiveTab()])
    .then(async ([controller, activeTab]) => {
      if (controller === null || activeTab === null) {
        statusElement.textContent = message("unsupportedTab");
        return undefined;
      }
      const result = await adoptControlledTab(
        controller.controllerId,
        activeTab,
      );
      if (result.status === "unsupported-page") {
        statusElement.textContent = message("adoptUnsupported");
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
  disconnectBrowserController()
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
  removeAllSiteAccess()
    .then(disconnectBrowserController)
    .then(renderAccess)
    .catch(() => {
      statusElement.textContent = message("accessUpdateFailed");
    })
    .finally(() => {
      revokeButton.disabled = false;
    });
});

await renderAccess();
