import { parseControllableUrl } from "./origin-policy";
import {
  containOpenedTab,
  readTabOwner,
  releaseToUser,
} from "./tab-containment";

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

// Tabs whose first URL is still to be judged. A worker restart forgets them;
// their network rules stay in place regardless.
const awaitingFirstUrl = new Set<number>();

export const forgetOpenedTab = (tabId: number): void => {
  awaitingFirstUrl.delete(tabId);
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

/**
 * Chrome names the tab whose page opened a new tab (`window.open`,
 * `target=_blank`, a middle click), from any frame. A tab one of the user's
 * pages opened is the user's. Any other stays confined, even when it was
 * already given to the user: this report wins whenever it arrives. One a
 * page chat operates opened is closed when its first URL fails the policy or
 * the page has opened too many; chat never operates it. The tab's
 * `openerTabId` is not used: Chrome may set it to whichever tab was active.
 */
export const sortNavigationTarget = async ({
  sourceTabId,
  tabId,
  url,
}: Pick<
  chrome.webNavigation.WebNavigationSourceCallbackDetails,
  "sourceTabId" | "tabId" | "url"
>): Promise<void> => {
  const source = await readTabOwner(sourceTabId);
  if (source === "inactive") {
    return;
  }
  if (source === "user") {
    await releaseToUser(tabId);
    return;
  }
  const fromControl = source === "controlled" || source === "opened";
  const containment = await containOpenedTab(tabId, { limited: fromControl });
  if (containment === "over-limit") {
    await chrome.tabs.remove(tabId);
    return;
  }
  if (containment === "contained" && fromControl) {
    awaitingFirstUrl.add(tabId);
    await judgeOpenedTab({
      ...(await chrome.tabs.get(tabId)),
      pendingUrl: url,
    });
  }
};

/**
 * Navigations only the browser's own interface starts: a page can open a
 * link, but not type into the address bar, open a bookmark or show the New
 * Tab page.
 */
const USER_TRANSITIONS = new Set<string>([
  "auto_bookmark",
  "generated",
  "keyword",
  "keyword_generated",
  "start_page",
  "typed",
]);
const NEW_TAB_PAGES = [
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome-search://local-ntp/",
];

const isUserNavigation = ({
  frameId,
  transitionQualifiers,
  transitionType,
  url,
}: Pick<
  chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  "frameId" | "transitionQualifiers" | "transitionType" | "url"
>): boolean =>
  frameId === 0 &&
  (USER_TRANSITIONS.has(transitionType) ||
    transitionQualifiers.includes("from_address_bar") ||
    NEW_TAB_PAGES.some((page) => url.startsWith(page)));

/**
 * A committed navigation is evidence that the user owns a tab no page
 * opened: they typed its address, opened a bookmark or a new tab. A tab
 * with no such evidence stays confined, however long it has been open; one
 * a page opened stays confined whatever the user does in it.
 */
export const sortCommittedNavigation = async (
  details: Pick<
    chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    "frameId" | "tabId" | "transitionQualifiers" | "transitionType" | "url"
  >,
): Promise<void> => {
  if (isUserNavigation(details)) {
    await releaseToUser(details.tabId);
  }
};
