import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import { hasAllSiteAccess } from "./access";
import {
  readStellaTabs,
  rememberStellaTab,
  type StellaTab,
  stellaTabsOnOrigin,
} from "./stella-tabs";
import {
  BROWSER_COMMAND_BUDGET_STORAGE_KEY,
  BROWSER_CONTROLLED_TAB_STORAGE_KEY,
  BROWSER_CONTROLLER_STORAGE_KEY,
  BROWSER_EXECUTION_RECEIPTS_STORAGE_KEY,
} from "./storage-keys";
import { releaseContainedTabs } from "./tab-containment";
import { trustedStellaOriginFromUrl } from "./trusted-origin";

/**
 * One connection of stella on one trusted origin. Every stella tab on that
 * origin shares it: the user connects once, not once per tab.
 */
export type BrowserController = {
  controllerId: string;
  origin: string;
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
    typeof input.origin !== "string"
  ) {
    return null;
  }
  return { controllerId: input.controllerId, origin: input.origin };
};

export const readBrowserController =
  async (): Promise<BrowserController | null> => {
    const stored = await chrome.storage.session.get(
      BROWSER_CONTROLLER_STORAGE_KEY,
    );
    return parseBrowserController(stored[BROWSER_CONTROLLER_STORAGE_KEY]);
  };

export const browserControllerMatchesSender = (
  controller: BrowserController,
  rawUrl: string,
): boolean => controller.origin === trustedStellaOriginFromUrl(rawUrl);

/** The connection a message from a stella page at `rawUrl` acts under. */
export const controllerForSender = async (
  rawUrl: string,
): Promise<BrowserController | null> => {
  const controller = await readBrowserController();
  return controller && browserControllerMatchesSender(controller, rawUrl)
    ? controller
    : null;
};

type ControllerStatus = {
  controlledTabId: number | null;
  controllerId: string | null;
};

const sendStatus = async (
  tabId: number,
  documentId: string | null,
  status: ControllerStatus,
  allSitesGranted: boolean,
): Promise<void> => {
  const response = {
    allSitesGranted,
    controlledTabId: status.controlledTabId,
    controllerId: status.controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: "controller-changed",
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
    type: "pong",
  } satisfies BrowserExtensionResponse;
  await (
    documentId === null
      ? chrome.tabs.sendMessage(tabId, response)
      : chrome.tabs.sendMessage(tabId, response, { documentId })
  ).catch(() => undefined);
};

/**
 * Tells every stella tab on `origin` which controller and controlled tab it
 * now has, so each web client drops what it approved for the previous ones.
 * A tab is addressed by the document it last messaged from, so a tab that
 * has since left `origin` never hears about the connection.
 */
export const notifyStellaTabs = async (
  origin: string,
  status: ControllerStatus,
): Promise<void> => {
  const [tabs, allSitesGranted] = await Promise.all([
    readStellaTabs(),
    hasAllSiteAccess(),
  ]);
  await Promise.all(
    stellaTabsOnOrigin(tabs, origin).map(
      async ([tabId, { documentId }]) =>
        await sendStatus(tabId, documentId, status, allSitesGranted),
    ),
  );
};

export type PairStellaTabResult =
  | { controller: BrowserController; status: "paired" }
  | { status: "unsupported-tab" };

/**
 * Connects stella on the origin of the tab the popup was opened on. A
 * connection on another origin ends.
 */
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
  } satisfies BrowserController;
  await chrome.storage.session.set({
    [BROWSER_CONTROLLER_STORAGE_KEY]: controller,
  });
  await chrome.storage.session.remove([...CONTROLLER_DATA_STORAGE_KEYS]);
  await releaseContainedTabs();
  // Its URL was read just now, so the tab is on `origin` even if its page
  // has not messaged the extension yet.
  await rememberStellaTab(tab.id, { documentId: null, origin });
  if (previous && previous.origin !== controller.origin) {
    await notifyStellaTabs(previous.origin, {
      controlledTabId: null,
      controllerId: null,
    });
  }
  await notifyStellaTabs(controller.origin, {
    controlledTabId: null,
    controllerId: controller.controllerId,
  });
  return { controller, status: "paired" };
};

/** Ends the connection: forgets its controlled tab, receipts and budget. */
const endBrowserController = async (): Promise<BrowserController | null> => {
  const controller = await readBrowserController();
  await chrome.storage.session.remove([...CONTROLLER_SESSION_STORAGE_KEYS]);
  // Control ended, so the user's former controlled tab is theirs again.
  await releaseContainedTabs();
  return controller;
};

export const disconnectBrowserController = async (): Promise<void> => {
  const controller = await endBrowserController();
  if (controller) {
    await notifyStellaTabs(controller.origin, {
      controlledTabId: null,
      controllerId: null,
    });
  }
};

/**
 * A stella tab closed: the connection ends with the last stella tab on its
 * origin. Returns whether it ended.
 */
export const endControllerAfterTabClosed = async (
  closed: StellaTab | null,
): Promise<boolean> => {
  const controller = await readBrowserController();
  if (controller === null || closed?.origin !== controller.origin) {
    return false;
  }
  const remaining = stellaTabsOnOrigin(
    await readStellaTabs(),
    controller.origin,
  );
  if (remaining.length > 0) {
    return false;
  }
  await endBrowserController();
  return true;
};
