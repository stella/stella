import type { PageMetadata } from "../types";
import { runTranslators } from "../translators/registry";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const extractPageMetadata = (): PageMetadata => {
      const selection =
        window.getSelection()?.toString().trim();
      return {
        url: window.location.href,
        title: document.title,
        ...(selection ? { selection } : {}),
      };
    };

    /** Send initial page metadata to the service worker. */
    const sendMetadata = () => {
      const metadata = extractPageMetadata();
      const translatorResult = runTranslators(
        metadata.url,
        document,
      );

      chrome.runtime.sendMessage({
        action: "page-metadata",
        payload: {
          ...metadata,
          ...(translatorResult ?? {}),
        },
      });
    };

    /** Listen for requests from the side panel / service worker. */
    chrome.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {
        if (message.action === "capture-selection") {
          const selection =
            window.getSelection()?.toString().trim();
          sendResponse({ selection: selection ?? null });
          return true;
        }

        if (message.action === "get-page-metadata") {
          const metadata = extractPageMetadata();
          const translatorResult = runTranslators(
            metadata.url,
            document,
          );
          sendResponse({
            metadata: {
              ...metadata,
              ...(translatorResult ?? {}),
            },
          });
          return true;
        }

        return false;
      },
    );

    // Notify the side panel when the user's text
    // selection changes (debounced to avoid spam).
    let selectionTimer: ReturnType<typeof setTimeout>;
    document.addEventListener("selectionchange", () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const selection =
          window.getSelection()?.toString().trim();
        chrome.runtime.sendMessage({
          action: "selection-changed",
          payload: selection ?? null,
        });
      }, 300);
    });

    // Run on load.
    sendMetadata();
  },
});
