import { defineBackground } from "wxt/utils/define-background";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
  type BrowserExtensionResponse,
  parseBrowserExtensionRequest,
} from "@stll/api-contract/browser-control";

import { hasAllSiteAccess } from "../lib/access";
import { browserControlError } from "../lib/browser-control-result";
import { createCommandGate } from "../lib/command-gate";
import {
  controllerForSender,
  forgetBrowserControllerTab,
} from "../lib/controller";
import { executeAtMostOnce } from "../lib/execution-ledger";
import {
  executeBrowserCommand,
  forgetControlledTab,
} from "../lib/tab-executor";
import { trustedStellaOriginFromUrl } from "../lib/trusted-origin";

const commandGate = createCommandGate();

const isTrustedSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== chrome.runtime.id || !sender.url) {
    return false;
  }
  return trustedStellaOriginFromUrl(sender.url) !== null;
};

export default defineBackground(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetControlledTab(tabId).catch(() => undefined);
    forgetBrowserControllerTab(tabId).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((rawMessage, sender) => {
    const message = parseBrowserExtensionRequest(rawMessage);
    const senderTabId = sender.tab?.id;
    if (!message || !isTrustedSender(sender) || senderTabId === undefined) {
      return;
    }

    const respond = async (): Promise<BrowserExtensionResponse> => {
      const allSitesGranted = await hasAllSiteAccess();
      const controller = await controllerForSender(
        senderTabId,
        sender.url ?? "",
      );
      if (message.type === "ping") {
        return {
          allSitesGranted,
          controllerId: controller?.controllerId ?? null,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          requestId: message.requestId,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "pong",
        };
      }

      let result: BrowserControlResult;
      if (!controller || controller.controllerId !== message.controllerId) {
        result = browserControlError(
          BROWSER_CONTROL_ERROR_CODE.staleController,
          "Connect this stella tab from the extension popup before using browser actions.",
        );
      } else if (!allSitesGranted) {
        result = browserControlError(
          BROWSER_CONTROL_ERROR_CODE.permissionDenied,
          "Grant stella access to websites from the extension popup.",
        );
      } else {
        const execution = await commandGate.run(
          async () =>
            await executeAtMostOnce({
              command: message.command,
              controllerId: message.controllerId,
              execute: async () =>
                await executeBrowserCommand(
                  message.controllerId,
                  message.command,
                ),
              toolCallId: message.toolCallId,
            }),
        );
        result =
          execution.status === "completed"
            ? execution.result
            : browserControlError(
                BROWSER_CONTROL_ERROR_CODE.controllerBusy,
                "Another approved browser action is still running. Wait for it to finish, then retry.",
              );
      }
      return {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        result,
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
  });
});
