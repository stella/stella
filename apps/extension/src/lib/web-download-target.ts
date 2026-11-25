import { readBrowserController } from "./controller";
import { BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY } from "./storage-keys";

/**
 * Where a download chat's tabs make under the web connection goes: the
 * stella tab (and its document) whose command the connection admitted
 * last, and that command's chat turn, which names the chat the stella tab
 * files it for. Stored for the session, so a worker restart between a
 * click and its download still finds it; ending the connection clears it.
 */
export type WebDownloadTarget = {
  controllerId: string;
  turnId: string;
  tabId: number;
  /** The stella document that sent the command; null when Chrome named none. */
  documentId: string | null;
};

const parseTarget = (input: unknown): WebDownloadTarget | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const controllerId: unknown = Reflect.get(input, "controllerId");
  const turnId: unknown = Reflect.get(input, "turnId");
  const tabId: unknown = Reflect.get(input, "tabId");
  const documentId: unknown = Reflect.get(input, "documentId");
  return typeof controllerId === "string" &&
    typeof turnId === "string" &&
    typeof tabId === "number" &&
    Number.isSafeInteger(tabId) &&
    (documentId === null || typeof documentId === "string")
    ? { controllerId, documentId, tabId, turnId }
    : null;
};

/** Records the web connection's admitted command as where its downloads go. */
export const rememberWebDownloadTarget = async (
  target: WebDownloadTarget,
): Promise<void> => {
  await chrome.storage.session.set({
    [BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY]: target,
  });
};

/**
 * Where a download goes now: the last command's stella tab, while the
 * connection that sent it is still the paired one; null otherwise, and the
 * download is stopped as before.
 */
export const readWebDownloadTarget =
  async (): Promise<WebDownloadTarget | null> => {
    const [stored, controller] = await Promise.all([
      chrome.storage.session.get(BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY),
      readBrowserController(),
    ]);
    const target = parseTarget(stored[BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY]);
    return target !== null && controller?.controllerId === target.controllerId
      ? target
      : null;
  };
