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

/** Rules for every tab except `excludedTabIds`, the user's own. */
const containmentRules = (
  excludedTabIds: number[],
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
      excludedTabIds,
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
      excludedTabIds,
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
      excludedTabIds,
      urlFilter: "|http:",
    },
    id: PLAIN_HTTP_BLOCK_RULE_ID,
    priority: 1,
  },
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...ALL_RESOURCE_TYPES],
      excludedTabIds,
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
      excludedTabIds,
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
        excludedTabIds,
      },
      id,
      priority: 1,
    }),
  ),
];

/**
 * Who a tab belongs to while control lasts: the tab chat operates, tabs
 * confined beside it (opened by a confined tab's page, or operated by chat
 * before), which chat never operates, and the user's own tabs. Each tab has
 * at most one owner. Every other tab is unknown and confined too: the network
 * rules exclude the user's tabs rather than list the confined ones, so a tab
 * Chrome has only just created is confined from its first request, until
 * there is evidence of who opened it.
 */
type ContainedTabs = {
  controlledTabId: number | null;
  openedTabIds: number[];
  userTabIds: number[];
};

const NO_CONTAINED_TABS: ContainedTabs = {
  controlledTabId: null,
  openedTabIds: [],
  userTabIds: [],
};

/** Requests that belong to no tab, such as a site's service worker. */
const NO_TAB_ID = -1;

const isTabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const parseContainedTabs = (input: unknown): ContainedTabs => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("controlledTabId" in input) ||
    (input.controlledTabId !== null && !isTabId(input.controlledTabId)) ||
    !("openedTabIds" in input) ||
    !Array.isArray(input.openedTabIds) ||
    !("userTabIds" in input) ||
    !Array.isArray(input.userTabIds)
  ) {
    return NO_CONTAINED_TABS;
  }
  return exclusiveOwners({
    controlledTabId: input.controlledTabId,
    openedTabIds: input.openedTabIds.filter(isTabId),
    userTabIds: input.userTabIds.filter(isTabId),
  });
};

/**
 * Gives every tab one owner. Should the lists ever overlap, confinement
 * wins: a tab both confined and the user's stays confined.
 */
export const exclusiveOwners = ({
  controlledTabId,
  openedTabIds,
  userTabIds,
}: ContainedTabs): ContainedTabs => {
  const opened = [...new Set(openedTabIds)].filter(
    (tabId) => tabId !== controlledTabId,
  );
  return {
    controlledTabId,
    openedTabIds: opened,
    userTabIds: [...new Set(userTabIds)].filter(
      (tabId) => tabId !== controlledTabId && !opened.includes(tabId),
    ),
  };
};

export const containedTabIds = ({
  controlledTabId,
  openedTabIds,
}: Pick<ContainedTabs, "controlledTabId" | "openedTabIds">): number[] => [
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

/** Tab owners as the download check reads them. */
export type TabOwners = {
  contained: readonly number[];
  user: readonly number[];
};

const ownersOf = (containment: ContainedTabs): TabOwners => ({
  contained: containedTabIds(containment),
  user: containment.userTabIds,
});

/** The stricter of two owner sets: confined in either, the user's in both. */
const stricterOwners = (left: TabOwners, right: TabOwners): TabOwners => ({
  contained: [...new Set([...left.contained, ...right.contained])],
  user: left.user.filter((tabId) => right.user.includes(tabId)),
});

const changeListeners = new Set<(owners: TabOwners) => void>();

/**
 * Calls `listener` with the owners in force, in the same task as every
 * change: while a change is applied, the stricter of the old and new owners;
 * once it is stored, the new ones. A reader of the owners is thus never
 * looser than the rules Chrome enforces.
 */
export const onContainedTabsChanged = (
  listener: (owners: TabOwners) => void,
): void => {
  changeListeners.add(listener);
};

const publishOwners = (owners: TabOwners): void => {
  for (const listener of changeListeners) {
    listener(owners);
  }
};

const sameIds = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length &&
  left.every((tabId, index) => right[index] === tabId);

const sameContainment = (left: ContainedTabs, right: ContainedTabs) =>
  left.controlledTabId === right.controlledTabId &&
  sameIds(left.openedTabIds, right.openedTabIds) &&
  sameIds(left.userTabIds, right.userTabIds);

type ContainmentChange<T> = (
  current: ContainedTabs,
  /** Every tab now open; read only when control starts. */
  openTabIds: () => Promise<number[]>,
) =>
  | Promise<{ next: ContainedTabs; result: T }>
  | { next: ContainedTabs; result: T };

const listOpenTabIds = async (): Promise<number[]> =>
  (await chrome.tabs.query({}))
    .map(({ id }) => id)
    .filter((tabId) => tabId !== undefined);

const updateContainedTabs = async <T>(
  change: ContainmentChange<T>,
  { rewriteUnchanged = false }: { rewriteUnchanged?: boolean } = {},
): Promise<T> => {
  const apply = async (): Promise<T> => {
    const current = await readContainedTabs();
    const changed = await change(current, listOpenTabIds);
    const next = exclusiveOwners(changed.next);
    const { result } = changed;
    // Most tab events concern tabs outside the set; they change nothing.
    if (!rewriteUnchanged && sameContainment(next, current)) {
      return result;
    }
    publishOwners(stricterOwners(ownersOf(current), ownersOf(next)));
    // The rules change before the stored set does, so a newly recorded tab
    // is always one Chrome already confines.
    if (containedTabIds(next).length === 0) {
      await chrome.storage.session.remove(BROWSER_CONTAINED_TABS_STORAGE_KEY);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: CONTROLLED_TAB_RULE_IDS,
      });
    } else {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: containmentRules([...next.userTabIds, NO_TAB_ID]),
        removeRuleIds: CONTROLLED_TAB_RULE_IDS,
      });
      await chrome.storage.session.set({
        [BROWSER_CONTAINED_TABS_STORAGE_KEY]: next,
      });
    }
    publishOwners(ownersOf(next));
    return result;
  };
  const next = containmentTail.then(apply, apply);
  containmentTail = next.catch(() => undefined);
  return await next;
};

const isActive = (containment: ContainedTabs): boolean =>
  containedTabIds(containment).length > 0;

/**
 * Confines the tab chat operates before it loads anything: no downloads,
 * and no request outside the public-HTTPS origin policy. When control
 * starts, every other tab open now is the user's; tabs created from then on
 * stay confined until there is evidence they are the user's. A tab chat
 * operated before stays confined, never operated, until control ends or it
 * closes: its page was chat's to drive, so handing chat another tab does not
 * free it.
 */
export const containControlledTab = async (tabId: number): Promise<void> => {
  await updateContainedTabs(async (current, openTabIds) => {
    const userTabIds = isActive(current)
      ? current.userTabIds
      : (await openTabIds()).filter(
          (openTabId) => !containedTabIds(current).includes(openTabId),
        );
    const previous = current.controlledTabId;
    const retained =
      previous === null || previous === tabId
        ? current.openedTabIds
        : [...current.openedTabIds, previous];
    return {
      next: {
        controlledTabId: tabId,
        openedTabIds: retained.filter((opened) => opened !== tabId),
        userTabIds: userTabIds.filter(
          (userTabId) => userTabId !== tabId && !retained.includes(userTabId),
        ),
      },
      result: undefined,
    };
  });
};

type TabOwner = "controlled" | "inactive" | "opened" | "unknown" | "user";

/** Who a tab belongs to now; `inactive` when nothing is contained. */
export const readTabOwner = async (tabId: number): Promise<TabOwner> => {
  const current = await readContainedTabs();
  if (!isActive(current)) {
    return "inactive";
  }
  if (current.controlledTabId === tabId) {
    return "controlled";
  }
  if (current.openedTabIds.includes(tabId)) {
    return "opened";
  }
  return current.userTabIds.includes(tabId) ? "user" : "unknown";
};

type OpenedTabContainment = "contained" | "inactive" | "over-limit";

/**
 * Confines a tab a confined tab's page opened, even one already given to
 * the user: a late report of its source always wins. With `limited`, a tab
 * beyond the limit is refused (`over-limit`) and the caller closes it.
 */
export const containOpenedTab = async (
  tabId: number,
  { limited }: { limited: boolean },
): Promise<OpenedTabContainment> =>
  await updateContainedTabs((current) => {
    const contained = containedTabIds(current);
    if (contained.length === 0) {
      return { next: current, result: "inactive" };
    }
    if (contained.includes(tabId)) {
      return { next: current, result: "contained" };
    }
    if (limited && current.openedTabIds.length >= OPENED_TAB_LIMIT) {
      return { next: current, result: "over-limit" };
    }
    return {
      next: {
        ...current,
        openedTabIds: [...current.openedTabIds, tabId],
        userTabIds: current.userTabIds.filter(
          (userTabId) => userTabId !== tabId,
        ),
      },
      result: "contained",
    };
  });

/**
 * Gives a tab to the user on evidence that the user, not a page, opened or
 * navigated it. A confined tab stays confined: evidence of the user's hand
 * never outweighs a page having opened it.
 */
export const releaseToUser = async (tabId: number): Promise<TabOwner> =>
  await updateContainedTabs((current) => {
    if (!isActive(current)) {
      return { next: current, result: "inactive" };
    }
    if (containedTabIds(current).includes(tabId)) {
      return {
        next: current,
        result: current.controlledTabId === tabId ? "controlled" : "opened",
      };
    }
    return {
      next: current.userTabIds.includes(tabId)
        ? current
        : { ...current, userTabIds: [...current.userTabIds, tabId] },
      result: "user",
    };
  });

/** Chrome swapped a tab for another; the new one keeps the old one's owner. */
export const replaceTab = async (
  addedTabId: number,
  removedTabId: number,
): Promise<void> => {
  await updateContainedTabs((current) => {
    const swap = (tabIds: readonly number[]) =>
      tabIds.map((tabId) => (tabId === removedTabId ? addedTabId : tabId));
    return {
      next: {
        controlledTabId:
          current.controlledTabId === removedTabId
            ? addedTabId
            : current.controlledTabId,
        openedTabIds: swap(current.openedTabIds),
        userTabIds: swap(current.userTabIds),
      },
      result: undefined,
    };
  });
};

/** A closed tab leaves the set; the others stay as they are. */
export const forgetContainedTab = async (tabId: number): Promise<void> => {
  await updateContainedTabs((current) => {
    const next = {
      controlledTabId:
        current.controlledTabId === tabId ? null : current.controlledTabId,
      openedTabIds: current.openedTabIds.filter((opened) => opened !== tabId),
      userTabIds: current.userTabIds.filter((userTabId) => userTabId !== tabId),
    };
    return {
      next: isActive(next) ? next : NO_CONTAINED_TABS,
      result: undefined,
    };
  });
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
