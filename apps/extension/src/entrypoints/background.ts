import { panic } from "better-result";
import { defineBackground } from "wxt/utils/define-background";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
  type BrowserExtensionRequest,
  type BrowserExtensionResponse,
  parseBrowserExtensionRequest,
} from "@stll/api-contract/browser-control";

import { hasAllSiteAccess, removeAllSiteAccess } from "../lib/access";
import { browserControlError } from "../lib/browser-control-result";
import { chargeStoredCommandBudget } from "../lib/command-budget";
import { createControlSession } from "../lib/control-session";
import {
  controllerForSender,
  disconnectBrowserController,
  forgetBrowserControllerTab,
  notifyControllerTab,
  pairStellaTab,
  readBrowserController,
} from "../lib/controller";
import {
  cancelContainedTabDownload,
  holdContainedTabDownload,
  isInDownloadScope,
  refreshDownloadScope,
} from "../lib/download-guard";
import { executeAtMostOnce } from "../lib/execution-ledger";
import {
  containPageOpenedTab,
  forgetOpenedTab,
  judgeOpenedTab,
} from "../lib/opened-tabs";
import {
  isExtensionPageSender,
  parsePopupRequest,
  POPUP_PORT_NAME,
  type PopupResponse,
} from "../lib/popup-request";
import {
  forgetContainedTab,
  onContainedTabsChanged,
} from "../lib/tab-containment";
import {
  adoptControlledTab,
  executeBrowserCommand,
  forgetControlledTab,
  readControlledTabId,
} from "../lib/tab-executor";
import { trustedStellaOriginFromUrl } from "../lib/trusted-origin";

/**
 * Every web command, cancel, popup change and tab loss goes through this
 * one session, so a disconnect can never race a command it should stop.
 */
const session = createControlSession();

const isTrustedSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== chrome.runtime.id || !sender.url) {
    return false;
  }
  return trustedStellaOriginFromUrl(sender.url) !== null;
};

/** Tells the controller's stella tab about a change to the controlled tab. */
const notifyController = async (): Promise<void> => {
  const controller = await readBrowserController();
  if (controller) {
    await notifyControllerTab(controller.tabId, {
      controlledTabId: await readControlledTabId(controller.controllerId),
      controllerId: controller.controllerId,
    });
  }
};

const handleTabRemoved = async (tabId: number): Promise<void> => {
  forgetOpenedTab(tabId);
  const controller = await readBrowserController();
  if (controller?.tabId === tabId) {
    await session.change(async () => {
      await forgetBrowserControllerTab(tabId);
    });
    return;
  }
  if (
    controller !== null &&
    (await readControlledTabId(controller.controllerId)) === tabId
  ) {
    await session.change(async () => {
      if (await forgetControlledTab(tabId)) {
        await notifyController();
      }
    });
    return;
  }
  await forgetContainedTab(tabId);
};

let downloadGuardRegistered = false;

/**
 * `downloads` is optional and granted with website access, so the listener
 * attaches at startup when it is already granted and on the grant otherwise.
 */
const registerDownloadGuard = (): void => {
  if (downloadGuardRegistered || !Reflect.has(chrome, "downloads")) {
    return;
  }
  downloadGuardRegistered = true;
  // Holding the file name keeps a judged download from finishing; the
  // created event covers downloads whose name something else chose.
  chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
    holdContainedTabDownload(download, suggest);
  });
  chrome.downloads.onCreated.addListener((download) => {
    cancelContainedTabDownload(download).catch(() => undefined);
  });
};

type CommandRequest = Extract<BrowserExtensionRequest, { type: "command" }>;

const runCommand = async (
  message: CommandRequest,
  senderTabId: number,
  senderUrl: string,
): Promise<BrowserControlResult> => {
  const execution = await session.runCommand(async (signal) => {
    // Checked inside the session: a pairing change that was queued ahead of
    // this command has been applied by now.
    const controller = await controllerForSender(senderTabId, senderUrl);
    if (!controller || controller.controllerId !== message.controllerId) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.staleController,
        "Connect this stella tab from the extension popup before using browser actions.",
      );
    }
    if (!(await hasAllSiteAccess())) {
      return browserControlError(
        BROWSER_CONTROL_ERROR_CODE.permissionDenied,
        "Grant stella access to websites from the extension popup.",
      );
    }
    return await executeAtMostOnce({
      command: message.command,
      controllerId: message.controllerId,
      execute: async () => {
        const overBudget = signal.aborted
          ? null
          : await chargeStoredCommandBudget({
              command: message.command,
              controllerId: message.controllerId,
              turnId: message.turnId,
            });
        if (overBudget !== null) {
          return browserControlError(
            BROWSER_CONTROL_ERROR_CODE.budgetExceeded,
            overBudget,
          );
        }
        return await executeBrowserCommand(
          message.controllerId,
          message.command,
          { observedTab: message.observedTab, signal },
        );
      },
      toolCallId: message.toolCallId,
    });
  });
  return execution.status === "completed"
    ? execution.result
    : browserControlError(
        BROWSER_CONTROL_ERROR_CODE.controllerBusy,
        "Another approved browser action is still running. Wait for it to finish, then retry.",
      );
};

const handleWebMessage = (
  rawMessage: unknown,
  sender: chrome.runtime.MessageSender,
): void => {
  const message = parseBrowserExtensionRequest(rawMessage);
  const senderTabId = sender.tab?.id;
  if (!message || !isTrustedSender(sender) || senderTabId === undefined) {
    return;
  }
  const senderUrl = sender.url ?? "";

  if (message.type === "cancel") {
    controllerForSender(senderTabId, senderUrl)
      .then((controller) => {
        if (controller?.controllerId === message.controllerId) {
          session.cancel();
        }
        return undefined;
      })
      .catch(() => undefined);
    return;
  }

  // Admitted synchronously, before any await, so a cancel the page sends
  // right after this command always finds it.
  const result =
    message.type === "command"
      ? runCommand(message, senderTabId, senderUrl)
      : null;

  const respond = async (): Promise<BrowserExtensionResponse> => {
    if (result === null) {
      const controller = await controllerForSender(senderTabId, senderUrl);
      return {
        allSitesGranted: await hasAllSiteAccess(),
        controlledTabId: controller
          ? await readControlledTabId(controller.controllerId)
          : null,
        controllerId: controller?.controllerId ?? null,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "pong",
      };
    }
    return {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: message.requestId,
      result: await result,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "command-result",
    };
  };
  respond()
    .catch((): BrowserExtensionResponse => ({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: message.requestId,
      result: {
        code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
        message: "The browser extension could not process this request.",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "error",
      },
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "command-result",
    }))
    .then(async (response) => {
      await chrome.tabs.sendMessage(senderTabId, response);
      return undefined;
    })
    .catch(() => undefined);
};

const handlePopupRequest = async (
  rawMessage: unknown,
): Promise<PopupResponse> => {
  const request = parsePopupRequest(rawMessage);
  if (!request) {
    return { status: "failed" };
  }
  switch (request.type) {
    case "pair":
      return await session.change<PopupResponse>(async () => {
        const paired = await pairStellaTab(request.tabId);
        return paired.status === "paired"
          ? { status: "done" }
          : { status: "unsupported-tab" };
      });
    case "adopt":
      return await session.change<PopupResponse>(async () => {
        const controller = await readBrowserController();
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        if (controller === null || tab === null) {
          return { status: "unsupported-tab" };
        }
        const adopted = await adoptControlledTab(controller.controllerId, tab);
        if (adopted.status === "unsupported-page") {
          return { status: "unsupported-page" };
        }
        await notifyController();
        return { status: "adopted", url: adopted.url };
      });
    case "disconnect":
      return await session.change<PopupResponse>(async () => {
        await disconnectBrowserController();
        return { status: "done" };
      });
    case "revoke":
      return await session.change<PopupResponse>(async () => {
        await removeAllSiteAccess();
        await disconnectBrowserController();
        return { status: "done" };
      });
    default:
      request satisfies never;
      return panic("Unhandled popup request");
  }
};

const refreshDownloads = (): void => {
  refreshDownloadScope().catch(() => undefined);
};

export default defineBackground(() => {
  onContainedTabsChanged(refreshDownloads);
  refreshDownloads();
  registerDownloadGuard();
  chrome.permissions.onAdded.addListener(registerDownloadGuard);

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(() => undefined);
  });
  chrome.tabs.onCreated.addListener((tab) => {
    containPageOpenedTab(tab).catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    judgeOpenedTab(tab).catch(() => undefined);
    if (change.url !== undefined && isInDownloadScope(tabId)) {
      refreshDownloads();
    }
  });

  chrome.runtime.onMessage.addListener((rawMessage, sender) => {
    handleWebMessage(rawMessage, sender);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT_NAME || !isExtensionPageSender(port.sender)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((rawMessage: unknown) => {
      handlePopupRequest(rawMessage)
        .catch((): PopupResponse => ({ status: "failed" }))
        .then((response) => {
          port.postMessage(response);
          return undefined;
        })
        .catch(() => undefined);
    });
  });
});
