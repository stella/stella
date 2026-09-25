import { parseControllableUrl } from "./origin-policy";
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

type DownloadAttribution = {
  /** Origins of the pages the contained tabs show. */
  containedOrigins: ReadonlySet<string>;
  download: DownloadSource;
};

/**
 * Downloads carry no tab, so one is attributed to a contained tab by the
 * origin it came from: its URL (a `blob:` URL names its creator), final URL
 * or referrer. One with no web origin at all, a `data:` URL without a
 * referrer, cannot be told apart, so it counts while any tab is contained.
 * Downloads other extensions start are theirs.
 */
export const isContainedTabDownload = ({
  containedOrigins,
  download,
}: DownloadAttribution): boolean => {
  if (download.byExtensionId !== undefined) {
    return false;
  }
  const origins = [download.url, download.finalUrl, download.referrer]
    .map(webOrigin)
    .filter((origin) => origin !== null);
  return (
    origins.length === 0 ||
    origins.some((origin) => containedOrigins.has(origin))
  );
};

/**
 * Origins of the pages contained tabs show. A tab showing a URL outside the
 * policy is on Chrome's blocked-page screen, so that origin is not counted.
 */
const readContainedOrigins = async (
  tabIds: readonly number[],
): Promise<Set<string>> => {
  const tabs = await Promise.all(
    tabIds.map(async (tabId) => await chrome.tabs.get(tabId).catch(() => null)),
  );
  return new Set(
    tabs
      .map((tab) =>
        tab?.url === undefined ? null : parseControllableUrl(tab.url)?.origin,
      )
      .filter((origin) => origin !== null && origin !== undefined),
  );
};

type DownloadScope = {
  origins: ReadonlySet<string>;
  tabIds: readonly number[];
};

// The contained tabs and their origins, kept in memory so a download can be
// judged in the same task Chrome reports it. Null until first loaded after
// the worker starts.
let scope: DownloadScope | null = null;

/** Reloads the scope; call when the contained set or a contained tab's URL changes. */
export const refreshDownloadScope = async (): Promise<void> => {
  const tabIds = containedTabIds(await readContainedTabs());
  scope = { origins: await readContainedOrigins(tabIds), tabIds };
};

export const isInDownloadScope = (tabId: number): boolean =>
  scope?.tabIds.includes(tabId) ?? false;

const judgeFromScope = (
  current: DownloadScope,
  download: DownloadSource,
): boolean =>
  current.tabIds.length > 0 &&
  isContainedTabDownload({ containedOrigins: current.origins, download });

const cancelDownload = async (downloadId: number): Promise<void> => {
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
  const [current] = await chrome.downloads.search({ id: downloadId });
  if (current?.state === "complete") {
    await chrome.downloads.removeFile(downloadId).catch(() => undefined);
  }
};

/**
 * Cancels a download a contained tab started. Network downloads and
 * non-page `blob:` or `data:` types never get this far (the tab's rules
 * block attachment and non-page responses); this catches a page script
 * saving a displayable type through `a[download]`. A download that finished
 * before the cancel landed has its file removed.
 */
export const cancelContainedTabDownload = async (
  download: chrome.downloads.DownloadItem,
): Promise<void> => {
  if (scope !== null && judgeFromScope(scope, download)) {
    await cancelDownload(download.id);
    return;
  }
  // The scope may predate a navigation or a new tab; judge again from the
  // stored set.
  await refreshDownloadScope();
  if (scope !== null && judgeFromScope(scope, download)) {
    await cancelDownload(download.id);
  }
};

/**
 * Chrome does not finish a download before every filename listener has
 * answered. A cancel sent before the answer reaches Chrome first, so a
 * download judged from the loaded scope never writes its file.
 */
export const holdContainedTabDownload = (
  download: chrome.downloads.DownloadItem,
  suggest: () => void,
): void => {
  if (scope !== null && judgeFromScope(scope, download)) {
    chrome.downloads.cancel(download.id).catch(() => undefined);
  }
  suggest();
};
