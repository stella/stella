import { describe, expect, test } from "bun:test";

import {
  browserControllerMatchesSender,
  disconnectBrowserController,
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
        ],
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
