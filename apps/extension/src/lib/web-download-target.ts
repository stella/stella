import { readBrowserController } from "./controller";
import { systemTraceClock } from "./download-trace";
import { BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY } from "./storage-keys";

/**
 * Where a download chat's tabs make under the web connection goes: the
 * stella tab (and its document) of the command the connection had admitted
 * when Chrome reported the download, and that command's chat turn, which
 * names the chat the stella tab files it for. A download is bound to the
 * command in force when it was reported, never to one admitted later, so a
 * download still being judged cannot ride another chat's later step. The recent
 * commands are stored for the session, so a worker restart between a click
 * and its download still finds them; ending the connection clears them.
 */
export type WebDownloadTarget = {
  controllerId: string;
  turnId: string;
  tabId: number;
  /** The stella document that sent the command; null when Chrome named none. */
  documentId: string | null;
};

/** A command as recorded: its target, and when the connection admitted it. */
type AdmittedTarget = WebDownloadTarget & {
  /** On the trace clock, in epoch milliseconds. */
  admittedAt: number;
};

/** Admitted commands remembered; older ones go first. */
const MAX_TARGETS = 8;

const parseTarget = (input: unknown): AdmittedTarget | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const controllerId: unknown = Reflect.get(input, "controllerId");
  const turnId: unknown = Reflect.get(input, "turnId");
  const tabId: unknown = Reflect.get(input, "tabId");
  const documentId: unknown = Reflect.get(input, "documentId");
  const admittedAt: unknown = Reflect.get(input, "admittedAt");
  return typeof controllerId === "string" &&
    typeof turnId === "string" &&
    typeof tabId === "number" &&
    Number.isSafeInteger(tabId) &&
    (documentId === null || typeof documentId === "string") &&
    typeof admittedAt === "number" &&
    Number.isFinite(admittedAt)
    ? { admittedAt, controllerId, documentId, tabId, turnId }
    : null;
};

const readTargets = async (): Promise<AdmittedTarget[]> => {
  const stored = await chrome.storage.session.get(
    BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY,
  );
  const raw: unknown = stored[BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY];
  return Array.isArray(raw)
    ? raw.flatMap((entry: unknown) => {
        const target = parseTarget(entry);
        return target === null ? [] : [target];
      })
    : [];
};

/** Records a command the web connection admits now. */
export const rememberWebDownloadTarget = async (
  target: WebDownloadTarget,
): Promise<void> => {
  const admittedAt = systemTraceClock.now();
  const targets = [...(await readTargets()), { ...target, admittedAt }];
  await chrome.storage.session.set({
    [BROWSER_WEB_DOWNLOAD_TARGET_STORAGE_KEY]: targets.slice(-MAX_TARGETS),
  });
};

/**
 * Where a download Chrome reported at `reportedAt` (on the trace clock)
 * goes: the stella tab of the last command admitted by then, while the
 * connection that sent it is still the paired one and is `pairing`, the
 * connection paired when Chrome reported the download. Null otherwise, and
 * the download is stopped as before: one reported before every remembered
 * command belongs to none of them.
 */
export const readWebDownloadTarget = async (
  pairing: string,
  reportedAt: number,
): Promise<WebDownloadTarget | null> => {
  const [targets, controller] = await Promise.all([
    readTargets(),
    readBrowserController(),
  ]);
  if (controller?.controllerId !== pairing) {
    return null;
  }
  const target = targets.findLast(({ admittedAt }) => admittedAt <= reportedAt);
  if (target?.controllerId !== pairing) {
    return null;
  }
  const { admittedAt: _admittedAt, ...webTarget } = target;
  return webTarget;
};
