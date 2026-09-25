import { parseControllableUrl } from "./origin-policy";
import { containOpenedTab } from "./tab-containment";

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
 * A page in a contained tab opened another tab (`window.open`,
 * `target=_blank`). Chrome reports it only after creating it, so its rules
 * follow at once, and it is closed when its first URL fails the policy or
 * the page has opened too many. Chat never operates it: it stays the
 * user's tab to look at, under the same network rules.
 */
export const containPageOpenedTab = async (
  tab: chrome.tabs.Tab,
): Promise<void> => {
  if (tab.id === undefined || tab.openerTabId === undefined) {
    return;
  }
  const containment = await containOpenedTab(tab.id, tab.openerTabId);
  if (containment === "unrelated") {
    return;
  }
  if (containment === "over-limit") {
    await chrome.tabs.remove(tab.id);
    return;
  }
  awaitingFirstUrl.add(tab.id);
  await judgeOpenedTab(tab);
};
