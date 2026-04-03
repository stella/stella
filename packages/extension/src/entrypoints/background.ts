import { stellaApi } from "../lib/api";
import type {
  ExternalMessage,
  InternalMessage,
  SaveClipResponse,
  GetMattersResponse,
  GetActiveMatterResponse,
} from "../lib/messages";
import { storage } from "../lib/storage";
import type { PageMetadata, QueuedClip } from "../types";

export default defineBackground(() => {
  /**
   * Most recently reported page metadata from the active tab's
   * content script. Kept in memory (not persisted).
   */
  let currentPageMetadata: PageMetadata | null = null;

  // -- Internal message handling (side panel + content scripts) --

  chrome.runtime.onMessage.addListener(
    (
      message: InternalMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      handleInternalMessage(message, sendResponse);
      // Return true to indicate async response.
      return true;
    },
  );

  const handleInternalMessage = (
    message: InternalMessage,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (message.action) {
      case "page-metadata": {
        currentPageMetadata = message.payload;
        sendResponse({ ok: true });
        break;
      }
      case "save-clip": {
        void handleSaveClip(
          message.payload.matterId,
          message.payload.data,
        ).then(sendResponse);
        break;
      }
      case "get-matters": {
        void handleGetMatters().then(sendResponse);
        break;
      }
      case "set-active-matter": {
        void storage
          .setActiveMatter(message.payload.matter)
          .then(() => sendResponse({ ok: true }));
        break;
      }
      case "get-active-matter": {
        void storage.getActiveMatter().then((matter) => {
          const response: GetActiveMatterResponse = {
            matter,
          };
          sendResponse(response);
        });
        break;
      }
      case "get-page-metadata": {
        sendResponse({ metadata: currentPageMetadata });
        break;
      }
      case "capture-selection": {
        // Forward to active tab's content script.
        chrome.tabs.query(
          { active: true, currentWindow: true },
          (tabs: chrome.tabs.Tab[]) => {
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
              sendResponse({ selection: null });
              return;
            }
            chrome.tabs.sendMessage(
              tabId,
              { action: "capture-selection" },
              sendResponse,
            );
          },
        );
        break;
      }
      default: {
        // Close the port for unhandled messages
        // (e.g. selection-changed, handled by side panel).
        sendResponse({ ok: true });
        break;
      }
    }
  };

  // -- External message handling (Stella web app) --

  chrome.runtime.onMessageExternal.addListener(
    (
      message: ExternalMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (message.action === "set-matter") {
        void storage
          .setActiveMatter(message.payload.matter)
          .then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    },
  );

  // -- Offline detection --

  const isOffline = (error: string) =>
    error === "Failed to fetch" ||
    error.includes("NetworkError") ||
    error.includes("timeout") ||
    error.includes("aborted") ||
    error.includes("The operation was aborted");

  // -- Save clip logic --

  const handleSaveClip = async (
    matterId: string,
    data: Parameters<typeof stellaApi.createClip>[1],
  ): Promise<SaveClipResponse> => {
    const result = await stellaApi.createClip(matterId, data);

    if (result.ok) {
      const matter = await storage.getActiveMatter();
      await storage.addRecentClip({
        id: result.data.entityId,
        title: data.title,
        url: data.url,
        matterId,
        matterName: matter?.name ?? "Unknown",
        savedAt: new Date().toISOString(),
      });
      return {
        success: true,
        entityId: result.data.entityId,
      };
    }

    // If offline or server unreachable, queue for later.
    if (isOffline(result.error)) {
      const queuedClip: QueuedClip = {
        id: crypto.randomUUID(),
        matterId,
        data,
        queuedAt: new Date().toISOString(),
      };
      await storage.addToOfflineQueue(queuedClip);
      return {
        success: false,
        error: "Saved to offline queue",
        queued: true,
      };
    }

    return { success: false, error: result.error };
  };

  // -- Matters fetching --

  const handleGetMatters = async (): Promise<GetMattersResponse> => {
    const result = await stellaApi.getMatters();
    if (result.ok) {
      return { success: true, matters: result.data };
    }
    return { success: false, error: result.error };
  };

  // -- Offline queue sync --

  const syncOfflineQueue = async () => {
    const queue = await storage.getOfflineQueue();
    if (queue.length === 0) {
      return;
    }

    for (const item of queue) {
      const result = await stellaApi.createClip(item.matterId, item.data);
      if (result.ok) {
        await storage.removeFromOfflineQueue(item.id);
        const matter = await storage.getActiveMatter();
        await storage.addRecentClip({
          id: result.data.entityId,
          title: item.data.title,
          url: item.data.url,
          matterId: item.matterId,
          matterName: matter?.name ?? "Unknown",
          savedAt: new Date().toISOString(),
        });
      } else if (isOffline(result.error)) {
        // Transient network error; stop and retry later.
        break;
      } else {
        // Permanent HTTP error (4xx); remove to unblock
        // the queue.
        await storage.removeFromOfflineQueue(item.id);
      }
    }
  };

  // Use chrome.alarms for periodic sync (survives MV3
  // service worker termination, unlike setInterval).
  // Guard creation so the alarm isn't reset on every
  // service worker restart.
  const SYNC_ALARM = "sync-offline-queue";
  void chrome.alarms.get(SYNC_ALARM).then((existing) => {
    if (existing === undefined) {
      void chrome.alarms.create(SYNC_ALARM, {
        periodInMinutes: 1,
      });
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void syncOfflineQueue();
    }
  });

  // -- Side panel setup --

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});
