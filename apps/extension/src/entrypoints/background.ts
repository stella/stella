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
import { storedCommandBudget } from "../lib/command-budget";
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
  enforceStoppedDownload,
  holdDownloadForJudgement,
  judgeDownload,
  refreshContainedDownloadScope,
  takeDownloadNotices,
} from "../lib/download-guard";
import { executeAtMostOnce } from "../lib/execution-ledger";
import {
  forgetOpenedTab,
  judgeOpenedTab,
  sortCommittedNavigation,
  sortNavigationTarget,
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
  replaceTab,
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

/**
 * `onDeterminingFilename` as Chrome documents it: a listener that answers
 * later returns true, and Chrome then waits for its `suggest`. The bundled
 * types declare a void listener.
 */
type FilenameEvents = {
  addListener: (
    listener: (
      download: chrome.downloads.DownloadItem,
      suggest: () => void,
    ) => boolean,
  ) => void;
};

const filenameEvents = (): FilenameEvents =>
  chrome.downloads.onDeterminingFilename;

let downloadGuardRegistered = false;
let navigationTargetsRegistered = false;

/**
 * `downloads` and `webNavigation` are optional and granted with website
 * access, so their listeners attach at startup when already granted and on
 * the grant otherwise.
 */
const registerOptionalListeners = (): void => {
  if (!downloadGuardRegistered && Reflect.has(chrome, "downloads")) {
    downloadGuardRegistered = true;
    // Chrome writes no file until the name is suggested, so a download is
    // judged first; the created event covers downloads whose name something
    // else chose.
    filenameEvents().addListener(holdDownloadForJudgement);
    chrome.downloads.onCreated.addListener((download) => {
      judgeDownload(download).catch(() => undefined);
    });
    chrome.downloads.onChanged.addListener((delta) => {
      enforceStoppedDownload(delta).catch(() => undefined);
    });
  }
  if (!navigationTargetsRegistered && Reflect.has(chrome, "webNavigation")) {
    navigationTargetsRegistered = true;
    chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
      sortNavigationTarget(details).catch(() => undefined);
    });
    chrome.webNavigation.onCommitted.addListener((details) => {
      sortCommittedNavigation(details).catch(() => undefined);
    });
  }
};

type CommandRequest = Extract<BrowserExtensionRequest, { type: "command" }>;

const runCommand = async (
  message: CommandRequest,
  senderTabId: number,
  senderUrl: string,
): Promise<BrowserControlResult> => {
  const execution = await session.runCommand(message.turnId, async (signal) => {
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
      execute: async () =>
        await executeBrowserCommand(message.controllerId, message.command, {
          budget: storedCommandBudget({
            command: message.command,
            controllerId: message.controllerId,
            turnId: message.turnId,
          }),
          observedTab: message.observedTab,
          signal,
        }),
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
    // The target is fixed on receipt; checking the sender reads storage,
    // and a command admitted meanwhile is not the one being stopped.
    const stop = session.stopTurn(message.turnId);
    controllerForSender(senderTabId, senderUrl)
      .then((controller) => {
        if (controller?.controllerId === message.controllerId) {
          stop();
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
    case "take-download-notices":
      return { ...(await takeDownloadNotices()), status: "download-notices" };
    default:
      request satisfies never;
      return panic("Unhandled popup request");
  }
};

const refreshDownloadScope = (): void => {
  refreshContainedDownloadScope().catch(() => undefined);
};

export default defineBackground(() => {
  onContainedTabsChanged(refreshDownloadScope);
  refreshDownloadScope();
  registerOptionalListeners();
  chrome.permissions.onAdded.addListener(registerOptionalListeners);

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(() => undefined);
  });
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    replaceTab(addedTabId, removedTabId).catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((_tabId, _change, tab) => {
    judgeOpenedTab(tab).catch(() => undefined);
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
