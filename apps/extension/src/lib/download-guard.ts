import { panic } from "better-result";

import { BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY } from "./storage-keys";
import { containedTabIds, readContainedTabs } from "./tab-containment";

type DownloadSource = Pick<
  chrome.downloads.DownloadItem,
  "byExtensionId" | "finalUrl" | "referrer" | "url"
>;

/** The web origin a URL belongs to; `blob:` URLs carry their creator's. */
const webOrigin = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    const inner = url.protocol === "blob:" ? new URL(url.pathname) : url;
    return inner.protocol === "https:" || inner.protocol === "http:"
      ? inner.origin
      : null;
  } catch {
    return null;
  }
};

/**
 * Whose download this is. Chrome does not say which tab or frame started a
 * download, so it is traced by origin (its URL, a `blob:` URL's creator,
 * its final URL, its referrer) to the frames open right now:
 * - `contained`: a frame in a tab stella controls has that origin;
 * - `user`: only frames in the user's own tabs do;
 * - `unknown`: no open frame does (a `data:` download without a referrer,
 *   an opaque origin, a frame already gone).
 * Other extensions' downloads are theirs.
 */
type DownloadOwner = "contained" | "unknown" | "user";

type DownloadOrigins = {
  contained: ReadonlySet<string>;
  user: ReadonlySet<string>;
};

export const downloadOwner = (
  download: DownloadSource,
  origins: DownloadOrigins,
): DownloadOwner => {
  if (download.byExtensionId !== undefined) {
    return "user";
  }
  const sources = downloadOrigins(download);
  if (sources.some((origin) => origins.contained.has(origin))) {
    return "contained";
  }
  return sources.some((origin) => origins.user.has(origin))
    ? "user"
    : "unknown";
};

const downloadOrigins = (download: DownloadSource): string[] =>
  [download.url, download.finalUrl, download.referrer]
    .map(webOrigin)
    .filter((origin) => origin !== null);

type DownloadAction = "allow" | "cancel" | "cancel-and-delete";

/**
 * What to do with a download while stella controls a tab. A download a
 * contained frame started is stopped, and its file deleted if it finished
 * first. One nobody can be traced to is stopped while it runs, but a file
 * that already finished is never deleted: it may be the user's.
 */
export const downloadAction = (
  owner: DownloadOwner,
  state: chrome.downloads.DownloadItem["state"],
): DownloadAction => {
  switch (owner) {
    case "user":
      return "allow";
    case "contained":
      return "cancel-and-delete";
    case "unknown":
      return state === "complete" ? "allow" : "cancel";
    default:
      owner satisfies never;
      return panic("Unhandled download owner");
  }
};

/** Origins of every frame in the given tabs, and of the tabs themselves. */
const frameOrigins = async (
  tabIds: readonly number[],
): Promise<Set<string>> => {
  const frames = await Promise.all(
    tabIds.map(
      async (tabId) =>
        (await chrome.webNavigation
          .getAllFrames({ tabId })
          .catch(() => null)) ?? [],
    ),
  );
  return new Set(
    frames
      .flat()
      .map(({ url }) => webOrigin(url))
      .filter((origin) => origin !== null),
  );
};

const readDownloadOrigins = async (
  contained: readonly number[],
): Promise<DownloadOrigins> => {
  const userTabIds = (await chrome.tabs.query({}))
    .map(({ id }) => id)
    .filter((tabId) => tabId !== undefined)
    .filter((tabId) => !contained.includes(tabId));
  return {
    contained: await frameOrigins(contained),
    user: await frameOrigins(userTabIds),
  };
};

/** Shows that a download was stopped on the toolbar icon until the popup opens. */
const noteStoppedDownload = async (): Promise<void> => {
  const stored = await chrome.storage.session.get(
    BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY,
  );
  const previous = stored[BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY];
  const count = (typeof previous === "number" ? previous : 0) + 1;
  await chrome.storage.session.set({
    [BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY]: count,
  });
  await chrome.action.setBadgeText({ text: String(count) });
  await chrome.action.setTitle({
    title: chrome.i18n.getMessage("downloadStopped"),
  });
};

// Downloads already judged; Chrome may report one through both events.
const judged = new Set<number>();
// Downloads stopped, and of those the ones a contained frame started, whose
// file is deleted if it lands after the cancel.
const stopped = new Set<number>();
const toDelete = new Set<number>();

// The contained tabs, kept in memory so a download can be stopped in the
// same task Chrome reports it; null until first read after the worker starts.
let containedNow: readonly number[] | null = null;

/** Re-reads the contained tabs; call after every change to them. */
export const refreshContainedDownloadScope = async (): Promise<void> => {
  containedNow = containedTabIds(await readContainedTabs());
};

/**
 * Judges a download while stella controls a tab. Network downloads and
 * non-page `blob:` or `data:` types never get this far (the tab's rules block
 * attachment and non-page responses); this catches a page script saving a
 * displayable type through `a[download]`. Called while Chrome waits for the
 * file name, so a stopped download writes no file; when Chrome skipped that
 * step, a contained frame's finished file is deleted.
 */
export const judgeDownload = async (
  download: chrome.downloads.DownloadItem,
): Promise<void> => {
  if (judged.has(download.id)) {
    return;
  }
  // A download with no web origin can be traced to nobody. It is stopped in
  // this same task, before the frame lookups below give it time to finish.
  if (
    containedNow !== null &&
    containedNow.length > 0 &&
    downloadOrigins(download).length === 0
  ) {
    judged.add(download.id);
    stopped.add(download.id);
    const cancelled = chrome.downloads.cancel(download.id);
    await cancelled.catch(() => undefined);
    await noteStoppedDownload();
    return;
  }
  const contained = containedNow ?? containedTabIds(await readContainedTabs());
  if (contained.length === 0) {
    return;
  }
  judged.add(download.id);
  const owner =
    downloadOrigins(download).length === 0
      ? "unknown"
      : downloadOwner(download, await readDownloadOrigins(contained));
  const [current] = await chrome.downloads.search({ id: download.id });
  const action = downloadAction(owner, current?.state ?? download.state);
  if (action === "allow") {
    return;
  }
  stopped.add(download.id);
  if (action === "cancel-and-delete") {
    toDelete.add(download.id);
  }
  await stopDownload(download.id);
  await noteStoppedDownload();
};

/** Cancels a download, and deletes its file if it was a contained frame's and finished. */
const stopDownload = async (downloadId: number): Promise<void> => {
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
  const [after] = await chrome.downloads.search({ id: downloadId });
  if (after?.state === "complete" && toDelete.has(downloadId)) {
    await chrome.downloads.removeFile(downloadId).catch(() => undefined);
  }
};

/**
 * Called for every download change. Chrome may let a download that was
 * stopped while it waited for its file name run on; it is stopped again,
 * and a contained frame's file deleted once it lands.
 */
export const enforceStoppedDownload = async (
  delta: chrome.downloads.DownloadDelta,
): Promise<void> => {
  if (!stopped.has(delta.id) || delta.state?.current === "interrupted") {
    return;
  }
  const [current] = await chrome.downloads.search({ id: delta.id });
  if (current === undefined || current.state === "interrupted") {
    return;
  }
  if (current.state === "complete" && !toDelete.has(delta.id)) {
    return;
  }
  await stopDownload(delta.id);
};

/**
 * Holds a download at its file name while it is judged. Chrome writes
 * nothing before `suggest` is called; returns true so Chrome waits for it.
 */
export const holdDownloadForJudgement = (
  download: chrome.downloads.DownloadItem,
  suggest: () => void,
): boolean => {
  judgeDownload(download)
    .catch(() => undefined)
    .then(() => {
      suggest();
      return undefined;
    })
    .catch(() => undefined);
  return true;
};

/** Clears the stopped-download notice once the user has seen it. */
export const takeStoppedDownloads = async (): Promise<number> => {
  const stored = await chrome.storage.session.get(
    BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY,
  );
  const count = stored[BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY];
  await chrome.storage.session.remove(BROWSER_STOPPED_DOWNLOADS_STORAGE_KEY);
  await chrome.action.setBadgeText({ text: "" });
  return typeof count === "number" ? count : 0;
};
