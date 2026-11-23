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

const isBlankUrl = (url: string | undefined): boolean =>
  url === undefined || url === "" || url === "about:blank";

/** Whether the tab shows that Chrome has begun loading a URL in it. */
const hasStartedLoading = ({
  pendingUrl,
  status,
  url,
}: Pick<chrome.tabs.Tab, "pendingUrl" | "status" | "url">): boolean =>
  status === "loading" || !isBlankUrl(pendingUrl) || !isBlankUrl(url);

const FIRST_LOAD = { closed: "closed", started: "started" } as const;

type FirstLoad = (typeof FIRST_LOAD)[keyof typeof FIRST_LOAD];

/**
 * Settles once Chrome has begun loading the first URL of a tab a page
 * opened, or the tab is gone. Chrome reports the tab while the page that
 * opened it can still be inside `window.open`: a debugger that holds new
 * windows at start (DevTools, browser automation) keeps it there, and
 * closing the tab meanwhile leaves that page frozen. The tab only starts
 * loading once `window.open` has returned; its network rules confine it
 * until then.
 */
const firstLoad = async (tabId: number): Promise<FirstLoad> => {
  const settled = Promise.withResolvers<FirstLoad>();
  const onUpdated = (
    updatedTabId: number,
    _change: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    if (updatedTabId === tabId && hasStartedLoading(tab)) {
      settled.resolve(FIRST_LOAD.started);
    }
  };
  const onRemoved = (removedTabId: number): void => {
    if (removedTabId === tabId) {
      settled.resolve(FIRST_LOAD.closed);
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  try {
    // Read once listening, so a change in between is not missed. Chrome
    // hides a plain-HTTP address from the tab, not from its top frame.
    const [tab, top] = await Promise.all([
      chrome.tabs.get(tabId).catch(() => null),
      chrome.webNavigation.getFrame({ frameId: 0, tabId }).catch(() => null),
    ]);
    if (tab === null) {
      return FIRST_LOAD.closed;
    }
    if (hasStartedLoading(tab) || !isBlankUrl(top?.url)) {
      return FIRST_LOAD.started;
    }
    return await settled.promise;
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  }
};

/**
 * Called for every tab update: closes a page-opened tab whose first URL
 * fails the origin policy. Later navigations stay under the tab's network
 * rules, as the controlled tab's do. An update that shows the URL is one
 * Chrome is loading, so the tab is past `window.open`.
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
 * page in chat's tabs opened becomes chat's, which chat may switch to; one
 * a merely confined tab opened is confined but never chat's, and either is
 * closed when its first URL fails the policy or too many tabs are open. One
 * an unknown tab opened is confined, never chat's. The tab's `openerTabId` is not used: Chrome may set it to
 * whichever tab was active.
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
  // Whether the source is chat's is decided again where the tab is recorded.
  const containment = await containOpenedTab(tabId, { sourceTabId });
  if (containment === "over-limit") {
    if ((await firstLoad(tabId)) === FIRST_LOAD.started) {
      await chrome.tabs.remove(tabId);
    }
    return;
  }
  if (
    (containment === "chat" || containment === "confined") &&
    (source === "controlled" || source === "chat" || source === "confined")
  ) {
    awaitingFirstUrl.add(tabId);
    if ((await firstLoad(tabId)) === FIRST_LOAD.closed) {
      return;
    }
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
