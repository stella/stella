import { describe, expect, test } from "bun:test";

import type { BrowserControlCommand } from "@stll/api-contract/browser-control";

import {
  BROWSER_APPROVAL_MODE,
  createBrowserApprovalStore,
  isBrowserCommandAutoApproved,
} from "./browser-approval-mode";

const read = { action: "snapshot" } satisfies BrowserControlCommand;
const act = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: { name: "Submit", ref: "e:0:0.1", role: "button" },
} satisfies BrowserControlCommand;

const STORAGE_KEY = "stella.chat.browserApprovalMode";

const memoryStorage = (values: Record<string, string> = {}): Storage => {
  const entries = new Map(Object.entries(values));
  return {
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()].at(index) ?? null,
    get length() {
      return entries.size;
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const blockedStorage = (): Storage => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("browser approval mode", () => {
  test("never auto-approves in the ask-every-time mode", () => {
    expect(
      isBrowserCommandAutoApproved({
        command: read,
        lastCommandSucceeded: true,
        mode: BROWSER_APPROVAL_MODE.askEveryTime,
      }),
    ).toBe(false);
  });

  test("the reads mode covers page reads only", () => {
    const autoApproved = (command: BrowserControlCommand) =>
      isBrowserCommandAutoApproved({
        command,
        lastCommandSucceeded: true,
        mode: BROWSER_APPROVAL_MODE.autoApproveReads,
      });

    expect(autoApproved(read)).toBe(true);
    expect(autoApproved({ action: "go-back" })).toBe(false);
    expect(autoApproved({ action: "open", url: "https://example.com/" })).toBe(
      false,
    );
    expect(autoApproved(act)).toBe(false);
  });

  test("the reads mode asks after a browser command did not succeed", () => {
    expect(
      isBrowserCommandAutoApproved({
        command: read,
        lastCommandSucceeded: false,
        mode: BROWSER_APPROVAL_MODE.autoApproveReads,
      }),
    ).toBe(false);
  });

  test("a stored legacy auto-approve-all mode falls back to asking", () => {
    const store = createBrowserApprovalStore(() =>
      memoryStorage({ [STORAGE_KEY]: JSON.stringify("auto-approve-all") }),
    );

    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);
  });

  test("restores a stored reads mode", () => {
    const storage = memoryStorage();
    createBrowserApprovalStore(() => storage).setMode(
      BROWSER_APPROVAL_MODE.autoApproveReads,
    );

    expect(createBrowserApprovalStore(() => storage).getMode()).toBe(
      BROWSER_APPROVAL_MODE.autoApproveReads,
    );
  });

  test("blocked storage falls back to asking and still keeps a chosen mode", () => {
    const store = createBrowserApprovalStore(blockedStorage);
    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);

    store.setMode(BROWSER_APPROVAL_MODE.autoApproveReads);
    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.autoApproveReads);
  });

  test("storage whose read throws falls back to asking", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
    const store = createBrowserApprovalStore(() => storage);

    expect(store.getMode()).toBe(BROWSER_APPROVAL_MODE.askEveryTime);
  });
});

describe("last browser command outcome", () => {
  test("reads wait for a successful command in this tab session", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    expect(store.lastCommandSucceeded()).toBe(false);

    const finish = store.beginCommand();
    expect(store.lastCommandSucceeded()).toBe(false);
    finish(true);
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("a failed command blocks reads until a later command succeeds", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    store.beginCommand()(true);

    store.beginCommand()(false);
    expect(store.lastCommandSucceeded()).toBe(false);

    store.beginCommand()(true);
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("an older command finishing late cannot vouch for a newer failure", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    const older = store.beginCommand();
    const newer = store.beginCommand();

    newer(false);
    older(true);

    expect(store.lastCommandSucceeded()).toBe(false);
  });

  test("notifies subscribers when the outcome changes", () => {
    const store = createBrowserApprovalStore(memoryStorage);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.beginCommand()(true);

    expect(notifications).toBe(2);
  });
});
