/** The tab fields opening stella reads. */
export type OpenStellaTab = Pick<
  chrome.tabs.Tab,
  "id" | "lastAccessed" | "pendingUrl" | "url" | "windowId"
>;

/** The browser calls opening stella makes; tests pass a fake. */
export type OpenStellaBrowser = {
  activateTab: (tabId: number) => Promise<unknown>;
  createTab: (url: string) => Promise<unknown>;
  focusWindow: (windowId: number) => Promise<unknown>;
  queryTabs: () => Promise<readonly OpenStellaTab[]>;
};

type OpenStellaOptions = {
  /** The trusted stella origin a URL is on, or null. */
  originFromUrl: (url: string) => string | null;
  /** Where stella opens when no stella tab is open; the first configured origin. */
  startOrigin: string | undefined;
};

export type OpenStellaResult =
  | { status: "focused"; tabId: number }
  | { status: "opened"; url: string }
  | { status: "no-origin" };

/** A tab still loading has its address only as the pending one. */
const tabAddress = ({ pendingUrl, url }: OpenStellaTab): string =>
  url !== undefined && url !== "" ? url : (pendingUrl ?? "");

/**
 * Brings the member to stella: the most recently used tab on a trusted
 * stella origin, in front in its window, or else a new tab on the start
 * origin. Connecting stays with the popup's connect action on that tab.
 */
export const openOrFocusStella = async (
  browser: OpenStellaBrowser,
  { originFromUrl, startOrigin }: OpenStellaOptions,
): Promise<OpenStellaResult> => {
  const stellaTab = (await browser.queryTabs())
    .filter((tab) => tab.id !== undefined)
    .filter((tab) => originFromUrl(tabAddress(tab)) !== null)
    .toSorted((left, right) => right.lastAccessed - left.lastAccessed)
    .at(0);
  if (stellaTab?.id !== undefined) {
    await browser.activateTab(stellaTab.id);
    await browser.focusWindow(stellaTab.windowId);
    return { status: "focused", tabId: stellaTab.id };
  }
  if (startOrigin === undefined) {
    return { status: "no-origin" };
  }
  const url = new URL("/", startOrigin).href;
  await browser.createTab(url);
  return { status: "opened", url };
};
