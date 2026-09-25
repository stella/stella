import { NON_PUBLIC_SECURE_URL_PATTERNS } from "./origin-policy";
import { BROWSER_CONTAINED_TABS_STORAGE_KEY } from "./storage-keys";
import { STELLA_HOSTNAMES } from "./trusted-origin";

const DOWNLOAD_BLOCK_RULE_ID = 1;
const PLAIN_HTTP_BLOCK_RULE_ID = 2;
const STELLA_BLOCK_RULE_ID = 3;
const PLAIN_WEBSOCKET_BLOCK_RULE_ID = 4;
const UNRENDERED_DOCUMENT_BLOCK_RULE_ID = 5;
const FIRST_NON_PUBLIC_HOST_RULE_ID = 10;

const NON_PUBLIC_HOST_RULES = NON_PUBLIC_SECURE_URL_PATTERNS.map(
  (regexFilter, index) => ({
    id: FIRST_NON_PUBLIC_HOST_RULE_ID + index,
    regexFilter,
  }),
);

export const CONTROLLED_TAB_RULE_IDS = [
  DOWNLOAD_BLOCK_RULE_ID,
  PLAIN_HTTP_BLOCK_RULE_ID,
  STELLA_BLOCK_RULE_ID,
  PLAIN_WEBSOCKET_BLOCK_RULE_ID,
  UNRENDERED_DOCUMENT_BLOCK_RULE_ID,
  ...NON_PUBLIC_HOST_RULES.map(({ id }) => id),
];

/**
 * Tabs a page opened from a contained tab stay contained until they close
 * or control ends. Beyond this many, a page-opened tab is closed at once.
 */
const OPENED_TAB_LIMIT = 8;

const DOCUMENT_RESOURCE_TYPES = ["main_frame", "sub_frame"] as const;

/**
 * Every request type, not only documents: a page must not reach a private
 * host or stella through fetch, images, scripts, WebSockets or beacons
 * either. A rule without `resourceTypes` would skip `main_frame`, so the
 * list is explicit.
 */
const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as const;

/**
 * Document types Chrome renders in a tab. A top-level or frame response of
 * any other type would become a download, so it is blocked before Chrome
 * hands it to the download manager.
 */
const RENDERED_DOCUMENT_TYPES = [
  "text/html*",
  "application/xhtml+xml*",
  "text/plain*",
  "text/xml*",
  "application/xml*",
  "application/*+xml*",
  "application/json*",
  "application/*+json*",
  "text/css*",
  "text/javascript*",
  "application/javascript*",
  "application/pdf*",
  "image/*",
  "video/*",
  "audio/*",
  "multipart/x-mixed-replace*",
];

const containmentRules = (
  tabIds: number[],
): chrome.declarativeNetRequest.Rule[] => [
  // Attachment responses are blocked before Chrome creates a download, so an
  // approved click can never write a file to the user's disk. Response-header
  // conditions need Chrome 128, which the manifest requires.
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...DOCUMENT_RESOURCE_TYPES, "other"],
      responseHeaders: [
        { header: "content-disposition", values: ["attachment*"] },
      ],
      tabIds,
    },
    id: DOWNLOAD_BLOCK_RULE_ID,
    priority: 1,
  },
  // A document Chrome would not render downloads even without an attachment
  // header.
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...DOCUMENT_RESOURCE_TYPES],
      responseHeaders: [
        { excludedValues: RENDERED_DOCUMENT_TYPES, header: "content-type" },
      ],
      tabIds,
    },
    id: UNRENDERED_DOCUMENT_BLOCK_RULE_ID,
    priority: 1,
  },
  // The origin policy holds for every request the tab makes, not only the
  // approved URL: links, form posts, redirects, subframes and subresources.
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...ALL_RESOURCE_TYPES],
      tabIds,
      urlFilter: "|http:",
    },
    id: PLAIN_HTTP_BLOCK_RULE_ID,
    priority: 1,
  },
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...ALL_RESOURCE_TYPES],
      tabIds,
      urlFilter: "|ws:",
    },
    id: PLAIN_WEBSOCKET_BLOCK_RULE_ID,
    priority: 1,
  },
  {
    action: { type: "block" },
    condition: {
      requestDomains: STELLA_HOSTNAMES,
      resourceTypes: [...ALL_RESOURCE_TYPES],
      tabIds,
    },
    id: STELLA_BLOCK_RULE_ID,
    priority: 1,
  },
  ...NON_PUBLIC_HOST_RULES.map(
    ({ id, regexFilter }): chrome.declarativeNetRequest.Rule => ({
      action: { type: "block" },
      condition: {
        regexFilter,
        resourceTypes: [...ALL_RESOURCE_TYPES],
        tabIds,
      },
      id,
      priority: 1,
    }),
  ),
];

/**
 * The contained tabs: the tab chat operates, and tabs pages in it opened
 * (`window.open`, `target=_blank`), which chat never operates.
 */
type ContainedTabs = {
  controlledTabId: number | null;
  openedTabIds: number[];
};

const NO_CONTAINED_TABS: ContainedTabs = {
  controlledTabId: null,
  openedTabIds: [],
};

const isTabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const parseContainedTabs = (input: unknown): ContainedTabs => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("controlledTabId" in input) ||
    (input.controlledTabId !== null && !isTabId(input.controlledTabId)) ||
    !("openedTabIds" in input) ||
    !Array.isArray(input.openedTabIds)
  ) {
    return NO_CONTAINED_TABS;
  }
  return {
    controlledTabId: input.controlledTabId,
    openedTabIds: input.openedTabIds.filter(isTabId),
  };
};

export const containedTabIds = ({
  controlledTabId,
  openedTabIds,
}: ContainedTabs): number[] => [
  ...(controlledTabId === null ? [] : [controlledTabId]),
  ...openedTabIds.filter((tabId) => tabId !== controlledTabId),
];

export const readContainedTabs = async (): Promise<ContainedTabs> => {
  const stored = await chrome.storage.session.get(
    BROWSER_CONTAINED_TABS_STORAGE_KEY,
  );
  return parseContainedTabs(stored[BROWSER_CONTAINED_TABS_STORAGE_KEY]);
};

// Tab events arrive concurrently with commands; every change to the set and
// its rules is applied one at a time, and each rewrite of the rules is one
// atomic `updateSessionRules` call.
let containmentTail: Promise<unknown> = Promise.resolve();

const changeListeners = new Set<() => void>();

/** Calls `listener` after every change to the contained set. */
export const onContainedTabsChanged = (listener: () => void): void => {
  changeListeners.add(listener);
};

const notifyChanged = (): void => {
  for (const listener of changeListeners) {
    listener();
  }
};

const updateContainedTabs = async <T>(
  change: (current: ContainedTabs) => { next: ContainedTabs; result: T },
  { rewriteUnchanged = false }: { rewriteUnchanged?: boolean } = {},
): Promise<T> => {
  const apply = async (): Promise<T> => {
    const current = await readContainedTabs();
    const { next, result } = change(current);
    // Most tab events concern tabs outside the set; they change nothing.
    if (
      !rewriteUnchanged &&
      next.controlledTabId === current.controlledTabId &&
      next.openedTabIds.length === current.openedTabIds.length &&
      next.openedTabIds.every(
        (tabId, index) => current.openedTabIds[index] === tabId,
      )
    ) {
      return result;
    }
    const tabIds = containedTabIds(next);
    // The rules change before the stored set does, so a newly recorded tab
    // is always one Chrome already confines.
    if (tabIds.length === 0) {
      await chrome.storage.session.remove(BROWSER_CONTAINED_TABS_STORAGE_KEY);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: CONTROLLED_TAB_RULE_IDS,
      });
    } else {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: containmentRules(tabIds),
        removeRuleIds: CONTROLLED_TAB_RULE_IDS,
      });
      await chrome.storage.session.set({
        [BROWSER_CONTAINED_TABS_STORAGE_KEY]: next,
      });
    }
    notifyChanged();
    return result;
  };
  const next = containmentTail.then(apply, apply);
  containmentTail = next.catch(() => undefined);
  return await next;
};

/**
 * Confines the tab chat operates before it loads anything: no downloads,
 * and no request outside the public-HTTPS origin policy. Tabs earlier pages
 * opened stay contained.
 */
export const containControlledTab = async (tabId: number): Promise<void> => {
  await updateContainedTabs(({ openedTabIds }) => ({
    next: {
      controlledTabId: tabId,
      openedTabIds: openedTabIds.filter((opened) => opened !== tabId),
    },
    result: undefined,
  }));
};

type OpenedTabContainment = "contained" | "over-limit" | "unrelated";

/**
 * Contains a tab a contained tab's page opened. `unrelated` when the opener
 * is not contained; `over-limit` when too many are open already, in which
 * case the caller closes the tab.
 */
export const containOpenedTab = async (
  tabId: number,
  openerTabId: number,
): Promise<OpenedTabContainment> =>
  await updateContainedTabs((current) => {
    if (!containedTabIds(current).includes(openerTabId)) {
      return { next: current, result: "unrelated" };
    }
    if (current.openedTabIds.length >= OPENED_TAB_LIMIT) {
      return { next: current, result: "over-limit" };
    }
    return {
      next: {
        ...current,
        openedTabIds: [
          ...current.openedTabIds.filter((opened) => opened !== tabId),
          tabId,
        ],
      },
      result: "contained",
    };
  });

/** A closed tab leaves the set; the others stay contained. */
export const forgetContainedTab = async (tabId: number): Promise<void> => {
  await updateContainedTabs((current) => ({
    next: {
      controlledTabId:
        current.controlledTabId === tabId ? null : current.controlledTabId,
      openedTabIds: current.openedTabIds.filter((opened) => opened !== tabId),
    },
    result: undefined,
  }));
};

/**
 * Control ended: every contained tab is the user's again. The rules are
 * removed even when the stored set is already empty.
 */
export const releaseContainedTabs = async (): Promise<void> => {
  await updateContainedTabs(
    () => ({ next: NO_CONTAINED_TABS, result: undefined }),
    { rewriteUnchanged: true },
  );
};
