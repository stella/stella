import { parseControllableUrl } from "./origin-policy";
import { classifyCreatedTab, readContainedTabs } from "./tab-containment";

type OpenedTabVerdict = "allowed" | "pending" | "refused";

/**
 * Judges the first URL of a tab a contained page opened. Chrome shows the
 * extension HTTPS URLs only, so a tab at `about:blank` or on another scheme
 * stays pending: its network rules already block plain HTTP.
 */
export const openedTabVerdict = ({
  pendingUrl,
  url,
}: Pick<chrome.tabs.Tab, "pendingUrl" | "url">): OpenedTabVerdict => {
  const candidate = pendingUrl ?? url;
  if (
    candidate === undefined ||
    candidate === "" ||
    candidate === "about:blank"
  ) {
    return "pending";
  }
  return parseControllableUrl(candidate) === null ? "refused" : "allowed";
};

/**
 * How long a new tab waits to learn which page opened it. Chrome reports a
 * page-opened tab's source together with its creation; a tab with no source
 * by then was opened by the user (a new-tab shortcut, a bookmark).
 */
const SOURCE_WAIT_MS = 1000;

// Tabs whose first URL is still to be judged. A worker restart forgets them;
// their network rules stay in place regardless.
const awaitingFirstUrl = new Set<number>();
// New tabs not yet sorted, with the timer that gives them to the user.
const awaitingSource = new Map<number, ReturnType<typeof setTimeout>>();

export const forgetOpenedTab = (tabId: number): void => {
  awaitingFirstUrl.delete(tabId);
  clearTimeout(awaitingSource.get(tabId));
  awaitingSource.delete(tabId);
};

/**
 * Called for every tab update: closes a page-opened tab whose first URL
 * fails the origin policy. Later navigations stay under the tab's network
 * rules, as the controlled tab's do.
 */
export const judgeOpenedTab = async (tab: chrome.tabs.Tab): Promise<void> => {
  if (tab.id === undefined || !awaitingFirstUrl.has(tab.id)) {
    return;
  }
  const verdict = openedTabVerdict(tab);
  if (verdict === "pending") {
    return;
  }
  awaitingFirstUrl.delete(tab.id);
  if (verdict === "refused") {
    await chrome.tabs.remove(tab.id);
  }
};

const sortTab = async (
  tabId: number,
  sourceTabId: number | null,
  firstUrl: string | undefined,
): Promise<void> => {
  const containment = await classifyCreatedTab(tabId, sourceTabId);
  if (containment === "user" || containment === "inactive") {
    return;
  }
  if (containment === "over-limit") {
    await chrome.tabs.remove(tabId);
    return;
  }
  awaitingFirstUrl.add(tabId);
  await judgeOpenedTab({
    ...(await chrome.tabs.get(tabId)),
    ...(firstUrl === undefined ? {} : { pendingUrl: firstUrl }),
  });
};

/**
 * A tab Chrome just created while control lasts. The network rules confine
 * every tab that is not known to be the user's, so this tab is confined from
 * its first request. It stays so until Chrome names the page that opened it
 * (see `sortNavigationTarget`), or is given to the user when no page did.
 * Its `openerTabId` is not used: Chrome may set it to whichever tab was
 * active rather than the page that opened it.
 */
export const holdCreatedTab = async (tab: chrome.tabs.Tab): Promise<void> => {
  const tabId = tab.id;
  if (tabId === undefined || awaitingSource.has(tabId)) {
    return;
  }
  const containment = await readContainedTabs();
  if (
    containment.controlledTabId === null &&
    containment.openedTabIds.length === 0
  ) {
    return;
  }
  awaitingSource.set(
    tabId,
    setTimeout(() => {
      awaitingSource.delete(tabId);
      sortTab(tabId, null, undefined).catch(() => undefined);
    }, SOURCE_WAIT_MS),
  );
};

/**
 * Chrome names the tab and frame whose page opened a new tab (`window.open`,
 * `target=_blank`, a middle click). A tab a contained page opened stays
 * confined and is closed when its first URL fails the policy or the page has
 * opened too many; chat never operates it. A tab one of the user's pages
 * opened is the user's.
 */
export const sortNavigationTarget = async ({
  sourceTabId,
  tabId,
  url,
}: Pick<
  chrome.webNavigation.WebNavigationSourceCallbackDetails,
  "sourceTabId" | "tabId" | "url"
>): Promise<void> => {
  clearTimeout(awaitingSource.get(tabId));
  awaitingSource.delete(tabId);
  await sortTab(tabId, sourceTabId, url);
};
