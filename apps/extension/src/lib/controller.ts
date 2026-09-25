import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import { hasAllSiteAccess } from "./access";
import {
  BROWSER_COMMAND_BUDGET_STORAGE_KEY,
  BROWSER_CONTROLLER_STORAGE_KEY,
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
} from "./storage-keys";
import { releaseContainedTabs } from "./tab-containment";
import { trustedStellaOriginFromUrl } from "./trusted-origin";

export type BrowserController = {
  controllerId: string;
  origin: string;
  tabId: number;
};

const CONTROLLER_DATA_STORAGE_KEYS = [
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
  BROWSER_COMMAND_BUDGET_STORAGE_KEY,
] as const;

const CONTROLLER_SESSION_STORAGE_KEYS = [
  BROWSER_CONTROLLER_STORAGE_KEY,
  ...CONTROLLER_DATA_STORAGE_KEYS,
] as const;

const parseBrowserController = (input: unknown): BrowserController | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("controllerId" in input) ||
    typeof input.controllerId !== "string" ||
    !("origin" in input) ||
    typeof input.origin !== "string" ||
    !("tabId" in input) ||
    typeof input.tabId !== "number" ||
    !Number.isSafeInteger(input.tabId)
  ) {
    return null;
  }
  return {
    controllerId: input.controllerId,
    origin: input.origin,
    tabId: input.tabId,
  };
};

export const readBrowserController =
  async (): Promise<BrowserController | null> => {
    const stored = await chrome.storage.session.get(
      BROWSER_CONTROLLER_STORAGE_KEY,
    );
    return parseBrowserController(stored[BROWSER_CONTROLLER_STORAGE_KEY]);
  };

export const controllerForSender = async (
  tabId: number,
  rawUrl: string,
): Promise<BrowserController | null> => {
  const controller = await readBrowserController();
  return controller && browserControllerMatchesSender(controller, tabId, rawUrl)
    ? controller
    : null;
};

export const browserControllerMatchesSender = (
  controller: BrowserController,
  tabId: number,
  rawUrl: string,
): boolean =>
  controller.tabId === tabId &&
  controller.origin === trustedStellaOriginFromUrl(rawUrl);

/**
 * Tells a stella tab which controller and controlled tab it now has, so the
 * web client drops what it approved for the previous ones.
 */
export const notifyControllerTab = async (
  tabId: number,
  status: { controlledTabId: number | null; controllerId: string | null },
): Promise<void> => {
  const response = {
    allSitesGranted: await hasAllSiteAccess(),
    controlledTabId: status.controlledTabId,
    controllerId: status.controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: "controller-changed",
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "pong",
  } satisfies BrowserExtensionResponse;
  await chrome.tabs.sendMessage(tabId, response).catch(() => undefined);
};

export type PairStellaTabResult =
  | { controller: BrowserController; status: "paired" }
  | { status: "unsupported-tab" };

/** Makes the stella tab the popup was opened on the controller. */
export const pairStellaTab = async (
  tabId: number,
): Promise<PairStellaTabResult> => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const origin = tab?.url ? trustedStellaOriginFromUrl(tab.url) : null;
  if (tab?.id === undefined || origin === null) {
    return { status: "unsupported-tab" };
  }

  const previous = await readBrowserController();
  const controller = {
    controllerId: crypto.randomUUID(),
    origin,
    tabId: tab.id,
  } satisfies BrowserController;
  await chrome.storage.session.set({
    [BROWSER_CONTROLLER_STORAGE_KEY]: controller,
  });
  await chrome.storage.session.remove([...CONTROLLER_DATA_STORAGE_KEYS]);
  await releaseContainedTabs();
  if (previous && previous.tabId !== controller.tabId) {
    await notifyControllerTab(previous.tabId, {
      controlledTabId: null,
      controllerId: null,
    });
  }
  await notifyControllerTab(controller.tabId, {
    controlledTabId: null,
    controllerId: controller.controllerId,
  });
  return { controller, status: "paired" };
};

export const disconnectBrowserController = async (): Promise<void> => {
  const controller = await readBrowserController();
  await chrome.storage.session.remove([...CONTROLLER_SESSION_STORAGE_KEYS]);
  await releaseContainedTabs();
  if (controller) {
    await notifyControllerTab(controller.tabId, {
      controlledTabId: null,
      controllerId: null,
    });
  }
};

export const forgetBrowserControllerTab = async (
  tabId: number,
): Promise<void> => {
  const controller = await readBrowserController();
  if (controller?.tabId !== tabId) {
    return;
  }
  await chrome.storage.session.remove([...CONTROLLER_SESSION_STORAGE_KEYS]);
  // Control ended, so the user's former controlled tab is theirs again.
  await releaseContainedTabs();
};
