import { describe, expect, test } from "bun:test";

import {
  openOrFocusStella,
  type OpenStellaBrowser,
  type OpenStellaTab,
} from "./open-stella";
import { createStellaOriginTrust } from "./trusted-origin";

const START_ORIGIN = "https://app.stll.app";
const { originFromUrl } = createStellaOriginTrust({
  hostedOrigins: [START_ORIGIN, "https://my.stll.app"],
  trustLoopback: false,
});

/** Records every call the way Chrome would receive it. */
const fakeBrowser = (tabs: readonly OpenStellaTab[]) => {
  const calls: string[] = [];
  const browser = {
    activateTab: async (tabId) => {
      calls.push(`activate ${tabId}`);
    },
    createTab: async (url) => {
      calls.push(`create ${url}`);
    },
    focusWindow: async (windowId) => {
      calls.push(`focus window ${windowId}`);
    },
    queryTabs: async () => tabs,
  } satisfies OpenStellaBrowser;
  return { browser, calls };
};

const tab = (
  id: number | undefined,
  url: string,
  fields: Partial<OpenStellaTab> = {},
): OpenStellaTab => ({
  ...(id === undefined ? {} : { id }),
  lastAccessed: 0,
  url,
  windowId: 1,
  ...fields,
});

const untrustedTabs = [
  tab(1, "https://example.com/"),
  // A lookalike host is not stella.
  tab(2, "https://app.stll.app.example.com/"),
  tab(3, "http://app.stll.app/"),
  tab(4, "chrome://extensions/"),
];

describe("opening stella from the popup", () => {
  test("brings the most recently used stella tab forward and opens nothing", async () => {
    const { browser, calls } = fakeBrowser([
      ...untrustedTabs,
      tab(10, `${START_ORIGIN}/chat`, { lastAccessed: 100, windowId: 1 }),
      tab(11, "https://my.stll.app/matters", {
        lastAccessed: 300,
        windowId: 2,
      }),
      tab(12, `${START_ORIGIN}/`, { lastAccessed: 200, windowId: 1 }),
    ]);
    expect(
      await openOrFocusStella(browser, {
        originFromUrl,
        startOrigin: START_ORIGIN,
      }),
    ).toEqual({ status: "focused", tabId: 11 });
    expect(calls).toEqual(["activate 11", "focus window 2"]);
  });

  test("counts a stella tab that is still loading as open", async () => {
    const { browser, calls } = fakeBrowser([
      tab(5, "", { pendingUrl: `${START_ORIGIN}/`, windowId: 3 }),
    ]);
    expect(
      await openOrFocusStella(browser, {
        originFromUrl,
        startOrigin: START_ORIGIN,
      }),
    ).toEqual({ status: "focused", tabId: 5 });
    expect(calls).toEqual(["activate 5", "focus window 3"]);
  });

  test("opens the start origin when no stella tab is open", async () => {
    const { browser, calls } = fakeBrowser([
      ...untrustedTabs,
      // Chrome reports no id for some tabs; those cannot be focused.
      tab(undefined, `${START_ORIGIN}/`),
    ]);
    expect(
      await openOrFocusStella(browser, {
        originFromUrl,
        startOrigin: START_ORIGIN,
      }),
    ).toEqual({ status: "opened", url: `${START_ORIGIN}/` });
    expect(calls).toEqual([`create ${START_ORIGIN}/`]);
  });

  test("changes nothing when no stella is open and none is configured", async () => {
    const { browser, calls } = fakeBrowser(untrustedTabs);
    expect(
      await openOrFocusStella(browser, {
        originFromUrl,
        startOrigin: undefined,
      }),
    ).toEqual({ status: "no-origin" });
    expect(calls).toEqual([]);
  });
});
