import { defineContentScript } from "wxt/utils/define-content-script";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserExtensionResponse,
  parseBrowserExtensionRequest,
  parseBrowserExtensionResponse,
  parseBrowserWebPeerVersion,
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
    const announce = () => {
      window.postMessage(
        {
          allSitesGranted: false,
          controlledTabId: null,
          controllerId: null,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          requestId: "extension-ready",
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "pong",
        } satisfies BrowserExtensionResponse,
        window.location.origin,
      );
    };

    window.addEventListener("message", ({ data, origin, source }) => {
      if (source !== window || origin !== window.location.origin) {
        return;
      }

      const request = parseBrowserExtensionRequest(data);
      if (!request) {
        // A tab on another protocol version hears this one, so it shows an
        // update or a reload rather than an install. Same-version requests
        // never get here, so the answer cannot loop.
        const webVersion = parseBrowserWebPeerVersion(data);
        if (
          webVersion !== null &&
          webVersion !== BROWSER_CONTROL_PROTOCOL_VERSION
        ) {
          announce();
        }
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

    announce();
  },
});
