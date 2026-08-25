import { describe, expect, test } from "bun:test";

import {
  browserControllerMatchesSender,
  disconnectBrowserController,
  type BrowserController,
} from "./controller";

const controller = {
  controllerId: "controller-1",
  origin: "http://localhost:3210",
  tabId: 42,
} satisfies BrowserController;

describe("browser controller lease", () => {
  test("binds the lease to one tab and exact origin", () => {
    expect(
      browserControllerMatchesSender(
        controller,
        42,
        "http://localhost:3210/chat",
      ),
    ).toBe(true);
    expect(
      browserControllerMatchesSender(
        controller,
        43,
        "http://localhost:3210/chat",
      ),
    ).toBe(false);
    expect(
      browserControllerMatchesSender(
        controller,
        42,
        "http://localhost:9999/chat",
      ),
    ).toBe(false);
  });

  test("deletes controller data and execution receipts on disconnect", async () => {
    const originalChrome = Object.getOwnPropertyDescriptor(
      globalThis,
      "chrome",
    );
    const removedKeys: unknown[] = [];
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
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
    } finally {
      if (originalChrome) {
        Object.defineProperty(globalThis, "chrome", originalChrome);
      } else {
        Reflect.deleteProperty(globalThis, "chrome");
      }
    }
  });
});
