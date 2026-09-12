import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import { hasAllSiteAccess } from "./access";
import { releaseDownloadContainment } from "./download-containment";
import {
  BROWSER_CONTROLLER_STORAGE_KEY,
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
} from "./storage-keys";
import { trustedStellaOriginFromUrl } from "./trusted-origin";

export type BrowserController = {
  controllerId: string;
  origin: string;
  tabId: number;
};

const CONTROLLER_DATA_STORAGE_KEYS = [
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
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

const controllerStatusResponse = async (
  controllerId: string | null,
): Promise<BrowserExtensionResponse> => ({
  allSitesGranted: await hasAllSiteAccess(),
  controllerId,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  requestId: "controller-changed",
  source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
  type: "pong",
});

const notifyControllerTab = async (
  tabId: number,
  controllerId: string | null,
): Promise<void> => {
  const response = await controllerStatusResponse(controllerId);
  await chrome.tabs.sendMessage(tabId, response).catch(() => undefined);
};

export type PairActiveStellaTabResult =
  | { controller: BrowserController; status: "paired" }
  | { status: "unsupported-tab" };

export const pairActiveStellaTab =
  async (): Promise<PairActiveStellaTabResult> => {
    const tab = (
      await chrome.tabs.query({ active: true, currentWindow: true })
    ).at(0);
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
    await releaseDownloadContainment();
    if (previous && previous.tabId !== controller.tabId) {
      await notifyControllerTab(previous.tabId, null);
    }
    await notifyControllerTab(controller.tabId, controller.controllerId);
    return { controller, status: "paired" };
  };

export const disconnectBrowserController = async (): Promise<void> => {
  const controller = await readBrowserController();
  await chrome.storage.session.remove([...CONTROLLER_SESSION_STORAGE_KEYS]);
  await releaseDownloadContainment();
  if (controller) {
    await notifyControllerTab(controller.tabId, null);
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
};
