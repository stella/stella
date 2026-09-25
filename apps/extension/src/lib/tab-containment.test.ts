import { afterEach, describe, expect, test } from "bun:test";

import {
  classifyCreatedTab,
  containControlledTab,
  forgetContainedTab,
} from "./tab-containment";

type Rule = { condition: { excludedTabIds?: number[]; tabIds?: number[] } };

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

/** Chrome with tabs 1 (stella) and 2 (a user page) open. */
const installFakeChrome = () => {
  const session: Record<string, unknown> = {};
  const openTabIds = [1, 2];
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
        query: async () => openTabIds.map((id) => ({ id })),
      },
    },
  });
  return { openTabIds, state };
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

describe("controlled tab containment", () => {
  test("a tab Chrome has only just created is confined before anyone sorts it", async () => {
    const { openTabIds, state } = installFakeChrome();
    openTabIds.push(3);
    await containControlledTab(3);

    // A page opens tab 4; its first request precedes the created event.
    expect(confines(state.rules, 4)).toBe(true);
    expect(confines(state.rules, 3)).toBe(true);
    expect(confines(state.rules, 1)).toBe(false);
    expect(confines(state.rules, 2)).toBe(false);
    // Requests that belong to no tab, such as service workers, are not.
    expect(confines(state.rules, -1)).toBe(false);

    expect(await classifyCreatedTab(4, 3)).toBe("contained");
    expect(confines(state.rules, 4)).toBe(true);
  });

  test("the user's own new tabs are released once they are known", async () => {
    const { openTabIds, state } = installFakeChrome();
    openTabIds.push(3);
    await containControlledTab(3);

    expect(await classifyCreatedTab(5, null)).toBe("user");
    expect(await classifyCreatedTab(6, 2)).toBe("user");
    expect(confines(state.rules, 5)).toBe(false);
    expect(confines(state.rules, 6)).toBe(false);
  });

  test("nothing is confined once the last contained tab closes", async () => {
    const { openTabIds, state } = installFakeChrome();
    openTabIds.push(3);
    await containControlledTab(3);
    await forgetContainedTab(3);

    expect(state.rules).toEqual([]);
    expect(await classifyCreatedTab(7, 3)).toBe("inactive");
    expect(state.rules).toEqual([]);
  });
});
