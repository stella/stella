import { describe, expect, test } from "bun:test";

import {
  browserControllerMatchesSender,
  disconnectBrowserController,
  replaceBrowserControllerTab,
  type BrowserController,
} from "./controller";
import { CONTROLLED_TAB_RULE_IDS } from "./tab-containment";

const controller = {
  controllerId: "controller-1",
  origin: "https://my.stll.app",
  tabId: 42,
} satisfies BrowserController;

describe("browser controller lease", () => {
  test("binds the lease to one tab and exact origin", () => {
    expect(
      browserControllerMatchesSender(
        controller,
        42,
        "https://my.stll.app/chat",
      ),
    ).toBe(true);
    expect(
      browserControllerMatchesSender(
        controller,
        43,
        "https://my.stll.app/chat",
      ),
    ).toBe(false);
    expect(
      browserControllerMatchesSender(
        controller,
        42,
        "https://app.stll.app/chat",
      ),
    ).toBe(false);
  });

  test("deletes controller data, receipts and the tab rules on disconnect", async () => {
    const originalChrome = Object.getOwnPropertyDescriptor(
      globalThis,
      "chrome",
    );
    const removedKeys: unknown[] = [];
    const removedRuleIds: unknown[] = [];
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        declarativeNetRequest: {
          updateSessionRules: async (options: { removeRuleIds?: number[] }) => {
            removedRuleIds.push(options.removeRuleIds);
          },
        },
        storage: {
          session: {
            get: async () => ({
              browserController: null,
            }),
            remove: async (keys: unknown) => {
              removedKeys.push(keys);
            },
          },
        },
      },
    });

    try {
      await disconnectBrowserController();
      expect(removedKeys).toEqual([
        [
          "browserController",
          "browserControlledTab",
          "browserExecutionReceipts",
          "browserCommandBudget",
        ],
        "browserContainedTabs",
      ]);
      expect(removedRuleIds).toEqual([CONTROLLED_TAB_RULE_IDS]);
    } finally {
      if (originalChrome) {
        Object.defineProperty(globalThis, "chrome", originalChrome);
      } else {
        Reflect.deleteProperty(globalThis, "chrome");
      }
    }
  });
});

describe("controller tab replacement", () => {
  test("the controller moves to the tab Chrome swapped in, so its sender matches", async () => {
    const originalChrome = Object.getOwnPropertyDescriptor(
      globalThis,
      "chrome",
    );
    const session: Record<string, unknown> = { browserController: controller };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          session: {
            get: async (key: string) => ({ [key]: session[key] }),
            set: async (items: Record<string, unknown>) => {
              Object.assign(session, items);
            },
          },
        },
      },
    });

    try {
      expect(await replaceBrowserControllerTab(43, 42)).toBe(true);
      expect(await replaceBrowserControllerTab(44, 99)).toBe(false);
      const moved = session["browserController"];
      if (
        typeof moved !== "object" ||
        moved === null ||
        !("tabId" in moved) ||
        moved.tabId !== 43
      ) {
        throw new TypeError("The controller did not move to the new tab");
      }
      expect(
        browserControllerMatchesSender(
          { ...controller, tabId: 43 },
          43,
          "https://my.stll.app/chat",
        ),
      ).toBe(true);
    } finally {
      if (originalChrome) {
        Object.defineProperty(globalThis, "chrome", originalChrome);
      } else {
        Reflect.deleteProperty(globalThis, "chrome");
      }
    }
  });
});
