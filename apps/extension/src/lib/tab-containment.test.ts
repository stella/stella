import { afterEach, describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";
import { sleep } from "@stll/concurrency/sleep";

import { sortCommittedNavigation, sortNavigationTarget } from "./opened-tabs";
import {
  chatTabsAtLimit,
  containControlledTab,
  exclusiveOwners,
  forgetContainedTab,
  readContainedTabs,
  readTabOwner,
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

  test("a late report that a controlled page opened the tab wins, in either order", async () => {
    const { session, state } = await startControl();
    // The user's evidence arrives first, the source report much later.
    await sortCommittedNavigation(typed(9));
    expect(await readTabOwner(9)).toBe("user");
    await sleep(1200);
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 9, url: "" });

    expect(await readTabOwner(9)).toBe("opened");
    expect(confines(state.rules, 9)).toBe(true);
    expect(session["browserContainedTabs"]).toMatchObject({
      openedTabIds: [9],
      userTabIds: [1, 2],
    });

    // The other order: evidence after the source report never frees it.
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 10, url: "" });
    await sortCommittedNavigation(typed(10));
    expect(await readTabOwner(10)).toBe("opened");
  });

  test("a tab an unknown tab opened stays confined", async () => {
    await startControl();
    await sortNavigationTarget({ sourceTabId: 11, tabId: 12, url: "" });
    await sortCommittedNavigation(typed(12));

    expect(await readTabOwner(12)).toBe("opened");
  });

  test("stored owner lists never overlap; confinement wins", async () => {
    const { session } = installFakeChrome();
    session["browserContainedTabs"] = {
      controlledTabId: 3,
      openedTabIds: [3, 4, 4],
      userTabIds: [1, 3, 4],
    };

    expect(await readContainedTabs()).toEqual({
      controlledTabId: 3,
      openedTabIds: [4],
      userTabIds: [1],
    });
    expect(
      exclusiveOwners({
        controlledTabId: null,
        openedTabIds: [5],
        userTabIds: [5, 6],
      }),
    ).toEqual({ controlledTabId: null, openedTabIds: [5], userTabIds: [6] });
  });

  test("handing chat another tab keeps each earlier one confined, once", async () => {
    const { session, state } = await startControl();
    await containControlledTab(2);
    await containControlledTab(4);
    await containControlledTab(CONTROLLED);

    expect(session["browserContainedTabs"]).toEqual({
      controlledTabId: CONTROLLED,
      openedTabIds: [2, 4],
      userTabIds: [1],
    });
    for (const tabId of [2, 4, CONTROLLED]) {
      expect(confines(state.rules, tabId)).toBe(true);
    }
    expect(await readTabOwner(2)).toBe("opened");
    // A tab the earlier one opens is confined as well.
    await sortNavigationTarget({ sourceTabId: 2, tabId: 13, url: "" });
    expect(await readTabOwner(13)).toBe("opened");
  });

  test("control moves only to one of chat's tabs, and the old one stays chat's", async () => {
    const { session, state } = await startControl();
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 5, url: "" });
    // Tab 1 is the user's, tab 6 has no known owner.
    for (const tabId of [1, 6]) {
      expect(await switchContainedTab(tabId)).toBe("refused");
    }
    expect(session["browserContainedTabs"]).toMatchObject({
      controlledTabId: CONTROLLED,
      openedTabIds: [5],
    });

    expect(await switchContainedTab(5)).toBe("switched");
    expect(session["browserContainedTabs"]).toEqual({
      controlledTabId: 5,
      openedTabIds: [CONTROLLED],
      userTabIds: [1, 2],
    });
    expect(confines(state.rules, CONTROLLED)).toBe(true);
    expect(confines(state.rules, 5)).toBe(true);
    expect(await switchContainedTab(5)).toBe("switched");
  });

  test("nothing is switched to while control is off", async () => {
    installFakeChrome();
    expect(await switchContainedTab(2)).toBe("refused");
    expect(await readTabOwner(2)).toBe("inactive");
  });

  test("chat keeps no more tabs than the limit, the controlled one included", async () => {
    const { removed } = await startControl();
    const limit = BROWSER_CONTROL_LIMITS.tabs;
    for (let tabId = 10; tabId < 10 + limit - 1; tabId += 1) {
      await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId, url: "" });
    }
    const contained = await readContainedTabs();
    expect(contained.openedTabIds).toHaveLength(limit - 1);
    expect(chatTabsAtLimit(contained)).toBe(true);

    // One more page-opened tab is closed at once.
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 30, url: "" });
    expect(removed).toEqual([30]);
    expect(chatTabsAtLimit(await readContainedTabs())).toBe(true);
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

    expect(await readTabOwner(5)).toBe("opened");
    expect(confines(state.rules, 5)).toBe(true);
    expect(await switchContainedTab(5)).toBe("switched");
  });

  test("nothing is confined once the last contained tab closes", async () => {
    const { state } = await startControl();
    await forgetContainedTab(CONTROLLED);

    expect(state.rules).toEqual([]);
    await sortNavigationTarget({ sourceTabId: CONTROLLED, tabId: 7, url: "" });
    expect(state.rules).toEqual([]);
  });
});
