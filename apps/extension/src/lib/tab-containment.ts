import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";

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
 * Chat's tabs (the controlled one, and those contained beside it) stay
 * contained until they close or control ends. Beyond this many, a
 * page-opened tab is closed at once and chat may not open another.
 */
const OPENED_TAB_LIMIT = BROWSER_CONTROL_LIMITS.tabs;

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
 * confined beside it, and the user's own tabs. Each tab has at most one
 * owner. Every other tab is unknown and confined too: the network rules
 * exclude the user's tabs rather than list the confined ones, so a tab
 * Chrome has only just created is confined from its first request, until
 * there is evidence of who opened it.
 *
 * Of the confined tabs, only chat's own may be operated again: tabs chat
 * controlled before, and tabs a page in one of chat's tabs opened. A tab an
 * unknown tab opened is confined but never chat's, and a tab the user
 * navigated themselves stops being chat's while it stays confined.
 */
type ContainedTabs = {
  /** Chat's tabs it handed over from the popup; restored when switched back to. */
  adoptedTabIds: number[];
  /** Confined tabs chat may switch to; a subset of `openedTabIds`. */
  chatTabIds: number[];
  controlledTabId: number | null;
  /**
   * The user navigated the controlled tab themselves; once control leaves
   * it, it stays confined but is no longer chat's.
   */
  controlledUserNavigated: boolean;
  openedTabIds: number[];
  userTabIds: number[];
};

const NO_CONTAINED_TABS: ContainedTabs = {
  adoptedTabIds: [],
  chatTabIds: [],
  controlledTabId: null,
  controlledUserNavigated: false,
  openedTabIds: [],
  userTabIds: [],
};

/** Requests that belong to no tab, such as a site's service worker. */
const NO_TAB_ID = -1;

const isTabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const parseTabIds = (input: object, key: string): number[] => {
  const value: unknown = Reflect.get(input, key);
  return Array.isArray(value) ? value.filter(isTabId) : [];
};

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
  // A set stored without the newer lists names no tab chat may operate,
  // which only takes away; every tab in it stays confined.
  return exclusiveOwners({
    adoptedTabIds: parseTabIds(input, "adoptedTabIds"),
    chatTabIds: parseTabIds(input, "chatTabIds"),
    controlledTabId: input.controlledTabId,
    controlledUserNavigated:
      "controlledUserNavigated" in input &&
      input.controlledUserNavigated === true,
    openedTabIds: input.openedTabIds.filter(isTabId),
    userTabIds: input.userTabIds.filter(isTabId),
  });
};

/**
 * Gives every tab one owner. Should the lists ever overlap, confinement
 * wins: a tab both confined and the user's stays confined. Chat's tabs are
 * only ever confined ones.
 */
export const exclusiveOwners = ({
  adoptedTabIds,
  chatTabIds,
  controlledTabId,
  controlledUserNavigated,
  openedTabIds,
  userTabIds,
}: ContainedTabs): ContainedTabs => {
  const opened = [...new Set(openedTabIds)].filter(
    (tabId) => tabId !== controlledTabId,
  );
  const chat = [...new Set(chatTabIds)].filter((tabId) =>
    opened.includes(tabId),
  );
  return {
    adoptedTabIds: [...new Set(adoptedTabIds)].filter(
      (tabId) => tabId === controlledTabId || chat.includes(tabId),
    ),
    chatTabIds: chat,
    controlledTabId,
    controlledUserNavigated:
      controlledTabId !== null && controlledUserNavigated,
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

/** The tabs chat may operate: the controlled one first, then its others. */
export const operableTabIds = ({
  chatTabIds,
  controlledTabId,
}: Pick<ContainedTabs, "chatTabIds" | "controlledTabId">): number[] => [
  ...(controlledTabId === null ? [] : [controlledTabId]),
  ...chatTabIds.filter((tabId) => tabId !== controlledTabId),
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
  left.controlledUserNavigated === right.controlledUserNavigated &&
  sameIds(left.adoptedTabIds, right.adoptedTabIds) &&
  sameIds(left.chatTabIds, right.chatTabIds) &&
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

/** Whether chat already has as many tabs as it may keep. */
export const chatTabsAtLimit = (
  containment: Pick<ContainedTabs, "chatTabIds" | "controlledTabId">,
): boolean => operableTabIds(containment).length >= OPENED_TAB_LIMIT;

type ContainControlledTabOptions = {
  /** The user handed the tab over from the popup. */
  adopted?: boolean;
  /**
   * When the tab would take chat past its tab limit: `refuse` changes
   * nothing, `drop-oldest` keeps the oldest of chat's other tabs confined
   * but no longer chat's.
   */
  atLimit?: "drop-oldest" | "refuse";
};

type ControlledTabContainment = "contained" | "over-limit";

/**
 * Confines the tab chat operates before it loads anything: no downloads,
 * and no request outside the public-HTTPS origin policy. When control
 * starts, every other tab open now is the user's; tabs created from then on
 * stay confined until there is evidence they are the user's. A tab chat
 * operated before stays confined until control ends or it closes, and stays
 * chat's to switch back to unless the user navigated it. The limit is
 * checked in the same step that adds the tab, so no tab opened meanwhile
 * can take chat past it.
 */
export const containControlledTab = async (
  tabId: number,
  { adopted = false, atLimit = "refuse" }: ContainControlledTabOptions = {},
): Promise<ControlledTabContainment> =>
  await updateContainedTabs(async (current, openTabIds) => {
    const userTabIds = isActive(current)
      ? current.userTabIds
      : (await openTabIds()).filter(
          (openTabId) => !containedTabIds(current).includes(openTabId),
        );
    const previous = current.controlledTabId;
    const moved = previous !== null && previous !== tabId;
    const retainedChat = [
      ...current.chatTabIds.filter((chatTabId) => chatTabId !== tabId),
      ...(moved && !current.controlledUserNavigated ? [previous] : []),
    ];
    const room = OPENED_TAB_LIMIT - 1;
    if (retainedChat.length > room && atLimit === "refuse") {
      return { next: current, result: "over-limit" };
    }
    const retained = moved
      ? [...current.openedTabIds, previous]
      : current.openedTabIds;
    return {
      next: {
        adoptedTabIds: adopted
          ? [...current.adoptedTabIds, tabId]
          : current.adoptedTabIds,
        chatTabIds: retainedChat.slice(Math.max(0, retainedChat.length - room)),
        controlledTabId: tabId,
        controlledUserNavigated: moved
          ? false
          : current.controlledUserNavigated,
        openedTabIds: retained.filter((opened) => opened !== tabId),
        userTabIds: userTabIds.filter(
          (userTabId) => userTabId !== tabId && !retained.includes(userTabId),
        ),
      },
      result: "contained",
    };
  });

type ChatTabSwitch =
  { adopted: boolean; status: "switched" } | { status: "refused" };

/**
 * Makes one of chat's tabs the controlled one; the tab controlled until now
 * stays confined beside it, and chat's unless the user navigated it. Any
 * other tab (the user's, an unknown one, one only confined, or any while
 * nothing is contained) is refused in the same step that would move
 * control, so a tab that changed owner meanwhile is never taken. `adopted`
 * says whether the user once handed the tab over from the popup.
 */
export const switchContainedTab = async (
  tabId: number,
): Promise<ChatTabSwitch> =>
  await updateContainedTabs(
    (
      current,
    ): {
      next: ContainedTabs;
      result: ChatTabSwitch;
    } => {
      const adopted = current.adoptedTabIds.includes(tabId);
      if (current.controlledTabId === tabId) {
        return { next: current, result: { adopted, status: "switched" } };
      }
      if (!current.chatTabIds.includes(tabId)) {
        return { next: current, result: { status: "refused" } };
      }
      const previous = current.controlledTabId;
      const previousStaysChat =
        previous !== null && !current.controlledUserNavigated;
      return {
        next: {
          ...current,
          chatTabIds: [
            ...current.chatTabIds.filter((chatTabId) => chatTabId !== tabId),
            ...(previousStaysChat ? [previous] : []),
          ],
          controlledTabId: tabId,
          controlledUserNavigated: false,
          openedTabIds: [
            ...current.openedTabIds.filter((opened) => opened !== tabId),
            ...(previous === null ? [] : [previous]),
          ],
        },
        result: { adopted, status: "switched" },
      };
    },
  );

type TabOwner =
  "chat" | "confined" | "controlled" | "inactive" | "unknown" | "user";

/** Who a tab belongs to now; `inactive` when nothing is contained. */
export const readTabOwner = async (tabId: number): Promise<TabOwner> => {
  const current = await readContainedTabs();
  if (!isActive(current)) {
    return "inactive";
  }
  if (current.controlledTabId === tabId) {
    return "controlled";
  }
  if (current.chatTabIds.includes(tabId)) {
    return "chat";
  }
  if (current.openedTabIds.includes(tabId)) {
    return "confined";
  }
  return current.userTabIds.includes(tabId) ? "user" : "unknown";
};

type OpenedTabContainment = "chat" | "confined" | "inactive" | "over-limit";

/**
 * Confines a tab another tab's page opened, even one already given to the
 * user: a late report of its source always wins. It becomes chat's only
 * when the page that opened it was in one of chat's tabs and the user has
 * not taken it meanwhile. A tab an unknown or merely confined tab opened is
 * confined, never chat's. A tab beyond the limit, chat's or one a confined
 * page opened, is refused (`over-limit`) and the caller closes it.
 */
export const containOpenedTab = async (
  tabId: number,
  { sourceTabId }: { sourceTabId: number },
): Promise<OpenedTabContainment> =>
  await updateContainedTabs(
    (
      current,
    ): {
      next: ContainedTabs;
      result: OpenedTabContainment;
    } => {
      const contained = containedTabIds(current);
      if (contained.length === 0) {
        return { next: current, result: "inactive" };
      }
      const operable = operableTabIds(current);
      if (contained.includes(tabId)) {
        return {
          next: current,
          result: operable.includes(tabId) ? "chat" : "confined",
        };
      }
      const toChat =
        operable.includes(sourceTabId) && !current.userTabIds.includes(tabId);
      // Chat's tabs count against chat's limit; a merely confined page may not
      // open more once that many tabs are confined in all.
      const overLimit = toChat
        ? operable.length >= OPENED_TAB_LIMIT
        : contained.includes(sourceTabId) &&
          contained.length >= OPENED_TAB_LIMIT;
      if (overLimit) {
        return { next: current, result: "over-limit" };
      }
      return {
        next: {
          ...current,
          chatTabIds: toChat
            ? [...current.chatTabIds, tabId]
            : current.chatTabIds,
          openedTabIds: [...current.openedTabIds, tabId],
          userTabIds: current.userTabIds.filter(
            (userTabId) => userTabId !== tabId,
          ),
        },
        result: toChat ? "chat" : "confined",
      };
    },
  );

/**
 * Gives a tab to the user on evidence that the user, not a page, opened or
 * navigated it. A confined tab stays confined: evidence of the user's hand
 * never outweighs a page having opened it. It is no longer chat's to switch
 * to, though, nor listed to chat; the controlled tab is so once control
 * leaves it.
 */
export const releaseToUser = async (tabId: number): Promise<TabOwner> =>
  await updateContainedTabs(
    (
      current,
    ): {
      next: ContainedTabs;
      result: TabOwner;
    } => {
      if (!isActive(current)) {
        return { next: current, result: "inactive" };
      }
      if (current.controlledTabId === tabId) {
        return {
          next: { ...current, controlledUserNavigated: true },
          result: "controlled",
        };
      }
      if (containedTabIds(current).includes(tabId)) {
        return {
          next: {
            ...current,
            chatTabIds: current.chatTabIds.filter(
              (chatTabId) => chatTabId !== tabId,
            ),
          },
          result: "confined",
        };
      }
      return {
        next: current.userTabIds.includes(tabId)
          ? current
          : { ...current, userTabIds: [...current.userTabIds, tabId] },
        result: "user",
      };
    },
  );

/**
 * Chat loaded a page of its own in the controlled tab, over whatever the
 * user had navigated it to: the tab is chat's again, and stays so once
 * control leaves it. Chrome commits a navigation the extension starts as a
 * plain link, never as the user's, so a later commit by the user still
 * counts.
 */
export const reclaimControlledTab = async (tabId: number): Promise<void> => {
  await updateContainedTabs((current) => ({
    next:
      current.controlledTabId === tabId
        ? { ...current, controlledUserNavigated: false }
        : current,
    result: undefined,
  }));
};

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
        adoptedTabIds: swap(current.adoptedTabIds),
        chatTabIds: swap(current.chatTabIds),
        controlledTabId:
          current.controlledTabId === removedTabId
            ? addedTabId
            : current.controlledTabId,
        controlledUserNavigated: current.controlledUserNavigated,
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
    const without = (tabIds: readonly number[]) =>
      tabIds.filter((other) => other !== tabId);
    const next = {
      adoptedTabIds: without(current.adoptedTabIds),
      chatTabIds: without(current.chatTabIds),
      controlledTabId:
        current.controlledTabId === tabId ? null : current.controlledTabId,
      controlledUserNavigated: current.controlledUserNavigated,
      openedTabIds: without(current.openedTabIds),
      userTabIds: without(current.userTabIds),
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
