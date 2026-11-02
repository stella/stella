import { afterEach, describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";
import { sleep } from "@stll/concurrency/sleep";

import { sortCommittedNavigation, sortNavigationTarget } from "./opened-tabs";
import {
  chatTabsAtLimit,
  containControlledTab,
  exclusiveOwners,
  forgetContainedTab,
  operableTabIds,
  readContainedTabs,
  readTabOwner,
  reclaimControlledTab,
  releaseContainedTabs,
  switchContainedTab,
} from "./tab-containment";

type Rule = { condition: { excludedTabIds?: number[]; tabIds?: number[] } };

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

/** Chrome with tabs 1 (stella) and 2 (a user page) open. */
const installFakeChrome = () => {
  const session: Record<string, unknown> = {};
  const openTabIds = [1, 2];
  const removed: number[] = [];
  const state = { rules: [] as Rule[] };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      declarativeNetRequest: {
        updateSessionRules: async ({ addRules }: { addRules?: Rule[] }) => {
          state.rules = addRules ?? [];
        },
      },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          remove: async (key: string) => {
            Reflect.deleteProperty(session, key);
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(session, items);
          },
        },
      },
      tabs: {
        get: async (id: number) => ({ id, url: "about:blank" }),
        query: async () => openTabIds.map((id) => ({ id })),
        remove: async (id: number) => {
          removed.push(id);
        },
      },
    },
  });
  return { openTabIds, removed, session, state };
};

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

/** Whether the rules apply to requests from `tabId`. */
const confines = (rules: readonly Rule[], tabId: number) =>
  rules.length > 0 &&
  rules.every(({ condition }) =>
    condition.tabIds === undefined
      ? !(condition.excludedTabIds ?? []).includes(tabId)
      : condition.tabIds.includes(tabId),
  );

const CONTROLLED = 3;
type CommittedNavigation = Parameters<typeof sortCommittedNavigation>[0];

const typed = (tabId: number): CommittedNavigation => ({
  frameId: 0,
  tabId,
  transitionQualifiers: [],
  transitionType: "typed",
  url: "https://example.com/",
});

const startControl = async () => {
  const fake = installFakeChrome();
  fake.openTabIds.push(CONTROLLED);
  await containControlledTab(CONTROLLED);
  return fake;
};

describe("controlled tab containment", () => {
  test("a tab Chrome has only just created is confined before anyone sorts it", async () => {
    const { state } = await startControl();

    expect(confines(state.rules, 4)).toBe(true);
    expect(confines(state.rules, CONTROLLED)).toBe(true);
    expect(confines(state.rules, 1)).toBe(false);
    expect(confines(state.rules, 2)).toBe(false);
    // Requests that belong to no tab, such as service workers, are not.
    expect(confines(state.rules, -1)).toBe(false);
  });

  test("a tab with no evidence of its owner stays confined, however long", async () => {
    const { state } = await startControl();
    await sleep(1200);

    expect(await readTabOwner(4)).toBe("unknown");
    expect(confines(state.rules, 4)).toBe(true);
  });

  test("a page the user opened, typed into or started from a new tab is theirs", async () => {
    const { state } = await startControl();
    await sortNavigationTarget({ sourceTabId: 2, tabId: 5, url: "" });
    await sortCommittedNavigation(typed(6));
    await sortCommittedNavigation({
      ...typed(7),
      transitionType: "link",
      url: "chrome://new-tab-page/",
    });
    // A link commit is no evidence at all.
    await sortCommittedNavigation({ ...typed(8), transitionType: "link" });

    for (const tabId of [5, 6, 7]) {
      expect(await readTabOwner(tabId)).toBe("user");
      expect(confines(state.rules, tabId)).toBe(false);
    }
    expect(await readTabOwner(8)).toBe("unknown");
  });

  test("a late report that a controlled page opened the tab confines it, in either order", async () => {
    const { session, state } = await startControl();
    // The user's evidence arrives first, the source report much later.
    await sortCommittedNavigation(typed(9));
    expect(await readTabOwner(9)).toBe("user");
    await sleep(1200);
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 9, url: "" });

    // Confined, but the user had it first, so it is not chat's.
    expect(await readTabOwner(9)).toBe("confined");
    expect(confines(state.rules, 9)).toBe(true);
    expect(session["browserContainedTabs"]).toMatchObject({
      chatTabIds: [],
      openedTabIds: [9],
      userTabIds: [1, 2],
    });

    // The other order: evidence after the source report never frees it,
    // but the tab is chat's no more.
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 10, url: "" });
    expect(await readTabOwner(10)).toBe("chat");
    await sortCommittedNavigation(typed(10));
    expect(await readTabOwner(10)).toBe("confined");
    expect(confines(state.rules, 10)).toBe(true);
  });

  test("a tab an unknown tab opened is confined but never chat's", async () => {
    const { state } = await startControl();
    // Tab 11 has no known owner: say a page the user opened from another
    // application. Its popup, and whatever that opens, stay out of chat's
    // reach.
    await sortNavigationTarget({ sourceTabId: 11, tabId: 12, url: "" });
    await sortNavigationTarget({ sourceTabId: 12, tabId: 14, url: "" });

    for (const tabId of [12, 14]) {
      expect(await readTabOwner(tabId)).toBe("confined");
      expect(confines(state.rules, tabId)).toBe(true);
      expect(await switchContainedTab(tabId)).toEqual({ status: "refused" });
    }
    const contained = await readContainedTabs();
    expect(operableTabIds(contained)).toEqual([CONTROLLED]);
    expect(contained.chatTabIds).toEqual([]);
  });

  test("stored owner lists never overlap; confinement wins", async () => {
    const { session } = installFakeChrome();
    session["browserContainedTabs"] = {
      adoptedTabIds: [6, 4],
      chatTabIds: [4, 5, 4],
      controlledTabId: 3,
      controlledUserNavigated: true,
      openedTabIds: [3, 4, 4],
      userTabIds: [1, 3, 4],
    };

    // Chat's tabs are only ever confined ones, adopted ones only chat's.
    expect(await readContainedTabs()).toEqual({
      adoptedTabIds: [4],
      chatTabIds: [4],
      controlledTabId: 3,
      controlledUserNavigated: true,
      openedTabIds: [4],
      userTabIds: [1],
    });
    expect(
      exclusiveOwners({
        adoptedTabIds: [],
        chatTabIds: [],
        controlledTabId: null,
        controlledUserNavigated: true,
        openedTabIds: [5],
        userTabIds: [5, 6],
      }),
    ).toEqual({
      adoptedTabIds: [],
      chatTabIds: [],
      controlledTabId: null,
      controlledUserNavigated: false,
      openedTabIds: [5],
      userTabIds: [6],
    });
  });

  test("a set stored without chat's lists names no tab chat may operate", async () => {
    const { session } = installFakeChrome();
    session["browserContainedTabs"] = {
      controlledTabId: 3,
      openedTabIds: [4],
      userTabIds: [1],
    };

    expect(await readTabOwner(4)).toBe("confined");
    expect(await switchContainedTab(4)).toEqual({ status: "refused" });
  });

  test("handing chat another tab keeps each earlier one confined and chat's, once", async () => {
    const { session, state } = await startControl();
    await containControlledTab(2);
    await containControlledTab(4);
    await containControlledTab(CONTROLLED);

    expect(session["browserContainedTabs"]).toEqual({
      adoptedTabIds: [],
      chatTabIds: [2, 4],
      controlledTabId: CONTROLLED,
      controlledUserNavigated: false,
      openedTabIds: [2, 4],
      userTabIds: [1],
    });
    for (const tabId of [2, 4, CONTROLLED]) {
      expect(confines(state.rules, tabId)).toBe(true);
    }
    expect(await readTabOwner(2)).toBe("chat");
    // A tab the earlier one opens is chat's as well.
    await sortNavigationTarget({ sourceTabId: 2, tabId: 13, url: "" });
    expect(await readTabOwner(13)).toBe("chat");
  });

  test("control moves only to one of chat's tabs, and the old one stays chat's", async () => {
    const { session, state } = await startControl();
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 5, url: "" });
    // Tab 1 is the user's, tab 6 has no known owner.
    for (const tabId of [1, 6]) {
      expect(await switchContainedTab(tabId)).toEqual({ status: "refused" });
    }
    expect(session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED,
      openedTabIds: [5],
    });

    expect(await switchContainedTab(5)).toEqual({
      adopted: false,
      status: "switched",
    });
    expect(session["browserContainedTabs"]).toEqual({
      adoptedTabIds: [],
      chatTabIds: [CONTROLLED],
      controlledTabId: 5,
      controlledUserNavigated: false,
      openedTabIds: [CONTROLLED],
      userTabIds: [1, 2],
    });
    expect(confines(state.rules, CONTROLLED)).toBe(true);
    expect(confines(state.rules, 5)).toBe(true);
    expect(await switchContainedTab(5)).toEqual({
      adopted: false,
      status: "switched",
    });
  });

  test("a tab the user navigated themselves stays confined but is no longer chat's", async () => {
    const { state } = await startControl();
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 5, url: "" });
    await sortCommittedNavigation(typed(5));
    expect(await switchContainedTab(5)).toEqual({ status: "refused" });
    expect(confines(state.rules, 5)).toBe(true);

    // The controlled tab the user navigated is not chat's once control
    // leaves it.
    await sortCommittedNavigation(typed(CONTROLLED));
    expect(await readTabOwner(CONTROLLED)).toBe("controlled");
    await containControlledTab(4);
    expect(await readTabOwner(CONTROLLED)).toBe("confined");
    expect(confines(state.rules, CONTROLLED)).toBe(true);
    expect(operableTabIds(await readContainedTabs())).toEqual([4]);
  });

  test("chat's own navigations never count as the user's", async () => {
    await startControl();
    // What Chromium reports for a page the extension loads with
    // `chrome.tabs.update`, and for going back through history.
    await sortCommittedNavigation({
      ...typed(CONTROLLED),
      transitionType: "link",
    });
    await sortCommittedNavigation({
      ...typed(CONTROLLED),
      transitionQualifiers: ["forward_back"],
      transitionType: "link",
    });
    await containControlledTab(4);
    expect(await readTabOwner(CONTROLLED)).toBe("chat");
  });

  test("a page chat loads over the user's navigation makes the tab chat's again", async () => {
    await startControl();
    await sortCommittedNavigation(typed(CONTROLLED));
    await reclaimControlledTab(CONTROLLED);
    await containControlledTab(4);
    expect(await readTabOwner(CONTROLLED)).toBe("chat");

    // A navigation by the user after chat's page counts again.
    await startControl();
    await sortCommittedNavigation(typed(CONTROLLED));
    await reclaimControlledTab(CONTROLLED);
    await sortCommittedNavigation(typed(CONTROLLED));
    await containControlledTab(4);
    expect(await readTabOwner(CONTROLLED)).toBe("confined");
  });

  test("a tab the user handed over is still theirs when chat switches back", async () => {
    await startControl();
    await containControlledTab(2, { adopted: true });
    await containControlledTab(4);

    expect(await switchContainedTab(2)).toEqual({
      adopted: true,
      status: "switched",
    });
    expect(await switchContainedTab(4)).toEqual({
      adopted: false,
      status: "switched",
    });
  });

  test("nothing is switched to while control is off", async () => {
    installFakeChrome();
    expect(await switchContainedTab(2)).toEqual({ status: "refused" });
    expect(await readTabOwner(2)).toBe("inactive");
  });

  test("chat keeps no more tabs than the limit, the controlled one included", async () => {
    const { removed, session } = await startControl();
    const limit = BROWSER_CONTROL_LIMITS.tabs;
    for (let tabId = 10; tabId < 10 + limit - 1; tabId += 1) {
      await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId, url: "" });
    }
    const contained = await readContainedTabs();
    expect(operableTabIds(contained)).toHaveLength(limit);
    expect(chatTabsAtLimit(contained)).toBe(true);

    // One more page-opened tab is closed at once.
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 30, url: "" });
    expect(removed).toEqual([30]);

    // A tab chat would control next is refused in the step that adds it,
    // and nothing changes.
    const before = structuredClone(session["browserContainedTabs"]);
    expect(await containControlledTab(40)).toBe("over-limit");
    expect(session["browserContainedTabs"]).toEqual(before);

    // The user's hand-over still succeeds; the oldest of chat's other tabs
    // stays confined but is no longer chat's.
    expect(
      await containControlledTab(41, { adopted: true, atLimit: "drop-oldest" }),
    ).toBe("contained");
    const adopted = await readContainedTabs();
    expect(operableTabIds(adopted)).toHaveLength(limit);
    expect(adopted.controlledTabId).toBe(41);
    expect(await readTabOwner(10)).toBe("confined");
    expect(await readTabOwner(CONTROLLED)).toBe("chat");
  });

  test("control ending gives every one of chat's tabs back to the user", async () => {
    const { state } = await startControl();
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 5, url: "" });
    await containControlledTab(4);
    await switchContainedTab(5);

    await releaseContainedTabs();
    expect(state.rules).toEqual([]);
    for (const tabId of [CONTROLLED, 4, 5]) {
      expect(await readTabOwner(tabId)).toBe("inactive");
    }
  });

  test("closing the controlled tab keeps chat's other tabs confined", async () => {
    const { state } = await startControl();
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 5, url: "" });
    await forgetContainedTab(CONTROLLED);

    expect(await readTabOwner(5)).toBe("chat");
    expect(confines(state.rules, 5)).toBe(true);
    expect(await switchContainedTab(5)).toEqual({
      adopted: false,
      status: "switched",
    });
  });

  test("nothing is confined once the last contained tab closes", async () => {
    const { state } = await startControl();
    await forgetContainedTab(CONTROLLED);

    expect(state.rules).toEqual([]);
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 7, url: "" });
    expect(state.rules).toEqual([]);
  });
});
