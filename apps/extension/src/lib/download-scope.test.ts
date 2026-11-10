import { afterEach, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { judgeDownload, setDownloadScope } from "./download-guard";
import {
  containControlledTab,
  onContainedTabsChanged,
  releaseContainedTabs,
} from "./tab-containment";

const CONTAINED_TABS_KEY = "browserContainedTabs";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
  if (originalChrome) {
    Object.defineProperty(globalThis, "chrome", originalChrome);
  } else {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

/**
 * Tabs 1 (stella) and 3 (on https://portal.example.com) are open. Storing
 * the contained set waits for the test, so a download can arrive while a
 * containment change is applied.
 */
const installFakeChrome = () => {
  const events: string[] = [];
  const session: Record<string, unknown> = {};
  const gate = { hold: false, release: (): void => undefined };
  const held = async (): Promise<void> => {
    if (gate.hold) {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      action: {
        setBadgeText: async () => undefined,
        setTitle: async () => undefined,
      },
      declarativeNetRequest: {
        updateSessionRules: async () => {
          events.push("rules");
        },
      },
      downloads: {
        cancel: async (id: number) => {
          events.push(`cancel:${id}`);
        },
        search: async ({ id }: { id: number }) => [
          { id, state: "in_progress" },
        ],
      },
      i18n: { getMessage: (name: string) => name },
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          remove: async (key: string) => {
            if (key === CONTAINED_TABS_KEY) {
              await held();
            }
            Reflect.deleteProperty(session, key);
          },
          set: async (items: Record<string, unknown>) => {
            if (CONTAINED_TABS_KEY in items) {
              await held();
            }
            Object.assign(session, items);
          },
        },
      },
      tabs: { query: async () => [{ id: 1 }, { id: 3 }] },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => [
          {
            frameId: 0,
            url:
              tabId === 3
                ? "https://portal.example.com/"
                : "https://files.example.org/",
          },
        ],
      },
    },
  });
  return { events, gate };
};

/** A small file a page in tab 3 saves from script. */
const savedInTab3 = (id: number): chrome.downloads.DownloadItem => ({
  bytesReceived: 0,
  canResume: false,
  danger: "safe",
  exists: true,
  fileSize: 10,
  filename: "",
  finalUrl: "blob:https://portal.example.com/7f0c",
  id,
  incognito: false,
  mime: "text/plain",
  paused: false,
  referrer: "",
  startTime: "2026-09-26T00:00:00.000Z",
  state: "in_progress",
  totalBytes: 10,
  url: "blob:https://portal.example.com/7f0c",
});

onContainedTabsChanged(setDownloadScope);

const settle = async () => {
  await sleep(5);
};

describe("download scope during containment changes", () => {
  test("a download that arrives while control starts is judged under it", async () => {
    const { events, gate } = installFakeChrome();
    setDownloadScope({ contained: [], user: [] });
    gate.hold = true;
    const starting = containControlledTab(3);
    await settle();
    // The rules are in place; the new owners are not stored yet.
    expect(events).toEqual(["rules"]);

    await judgeDownload(savedInTab3(61));
    expect(events).toContain("cancel:61");

    gate.release();
    await starting;
  });

  test("a user's download right after control ends goes through", async () => {
    const { events } = installFakeChrome();
    await containControlledTab(3);
    await releaseContainedTabs();

    await judgeDownload(savedInTab3(62));
    expect(events).not.toContain("cancel:62");
  });
});
