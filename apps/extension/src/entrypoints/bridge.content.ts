import { defineContentScript } from "wxt/utils/define-content-script";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  parseBrowserExtensionRequest,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import {
  STELLA_CONTENT_SCRIPT_MATCHES,
  trustedStellaOriginFromUrl,
} from "../lib/trusted-origin";

export default defineContentScript({
  matches: [...STELLA_CONTENT_SCRIPT_MATCHES],
  main() {
    if (trustedStellaOriginFromUrl(window.location.href) === null) {
      return;
    }
    window.addEventListener("message", ({ data, origin, source }) => {
      if (source !== window || origin !== window.location.origin) {
        return;
      }

      const request = parseBrowserExtensionRequest(data);
      if (!request) {
        return;
      }

      chrome.runtime.sendMessage(request).catch(() => undefined);
    });

    chrome.runtime.onMessage.addListener((rawResponse) => {
      const response = parseBrowserExtensionResponse(rawResponse);
      if (!response) {
        return;
      }
      window.postMessage(response, window.location.origin);
    });

    window.postMessage(
      {
        allSitesGranted: false,
        controllerId: null,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "extension-ready",
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "pong",
      },
      window.location.origin,
    );
  },
});
