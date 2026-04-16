import type { PageMetadata } from "../types";

type ContentMessage =
  | { action: "capture-selection" }
  | { action: "get-page-metadata" };

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const extractPageMetadata = (): PageMetadata => {
      const selection = window.getSelection()?.toString().trim();
      return {
        url: window.location.href,
        title: document.title,
        ...(selection ? { selection } : {}),
      };
    };

    /** Send initial page metadata to the service worker. */
    const sendMetadata = () => {
      const metadata = extractPageMetadata();

      void chrome.runtime.sendMessage({
        action: "page-metadata",
        payload: metadata,
      });
    };

    /** Listen for requests from the side panel / service worker. */
    chrome.runtime.onMessage.addListener(
      (message: ContentMessage, _sender, sendResponse) => {
        if (message.action === "capture-selection") {
          const selection = window.getSelection()?.toString().trim();
          sendResponse({ selection: selection ?? null });
          return true;
        }

        if (message.action === "get-page-metadata") {
          const metadata = extractPageMetadata();
          sendResponse({
            metadata,
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
        const selection = window.getSelection()?.toString().trim();
        void chrome.runtime.sendMessage({
          action: "selection-changed",
          payload: selection ?? null,
        });
      }, 300);
    });

    sendMetadata();
  },
});
