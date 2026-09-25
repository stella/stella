import { describe, expect, test } from "bun:test";

import type { BrowserControlCommand } from "@stll/api-contract/browser-control";

import { checkCommandIdentity, type SnapshotState } from "./snapshot-guard";

const URL_A = "https://example.com/";
const click = {
  action: "click",
  page: { revision: "revision-1", url: URL_A },
  target: { name: "Submit", ref: "e:2:1", role: "button" },
} satisfies BrowserControlCommand;
const snapshot = {
  documents: { "0": "document-top", "2": "document-frame" },
  revision: "revision-1",
  tabId: 7,
  url: URL_A,
} satisfies SnapshotState;
const controlledTab = { adopted: false, tabId: 7, url: URL_A };
const observedTab = { revision: "revision-1", tabId: 7 };

describe("browser command identity", () => {
  test("an element command acts in the document its snapshot read", () => {
    expect(
      checkCommandIdentity({
        command: click,
        controlledTab,
        observedTab,
        snapshot,
      }),
    ).toEqual({ documentId: "document-frame", status: "ok" });
  });

  test("requires the stored revision, its tab and the current tab URL", () => {
    for (const [changedSnapshot, changedTab] of [
      [{ ...snapshot, revision: "revision-2" }, controlledTab],
      [snapshot, { ...controlledTab, url: `${URL_A}redirected` }],
      [{ ...snapshot, tabId: 8 }, controlledTab],
      [{ ...snapshot, documents: { "0": "document-top" } }, controlledTab],
      [null, controlledTab],
    ] as const) {
      expect(
        checkCommandIdentity({
          command: click,
          controlledTab: changedTab,
          observedTab: null,
          snapshot: changedSnapshot,
        }),
      ).toEqual({ status: "stale-snapshot" });
    }
  });

  test("refuses navigations and actions after the controlled tab changed", () => {
    const adoptedTab = { adopted: true, tabId: 9, url: URL_A };
    for (const command of [
      click,
      { action: "go-back" },
      { action: "open", url: URL_A },
    ] satisfies BrowserControlCommand[]) {
      expect(
        checkCommandIdentity({
          command,
          controlledTab: adoptedTab,
          observedTab,
          snapshot: null,
        }),
      ).toEqual({ status: "tab-changed" });
    }
    // Reading the tab the user handed over is how chat learns about it.
    expect(
      checkCommandIdentity({
        command: { action: "snapshot" },
        controlledTab: adoptedTab,
        observedTab,
        snapshot: null,
      }),
    ).toEqual({ documentId: null, status: "ok" });
  });

  test("a web client that saw no tab never navigates one the user handed over", () => {
    const open = { action: "open", url: URL_A } satisfies BrowserControlCommand;
    for (const tab of [null, controlledTab]) {
      // No tab yet, or chat's own tab after an open whose result was lost.
      expect(
        checkCommandIdentity({
          command: open,
          controlledTab: tab,
          observedTab: null,
          snapshot: null,
        }),
      ).toEqual({ documentId: null, status: "ok" });
    }
    for (const command of [
      open,
      { action: "go-back" },
    ] satisfies BrowserControlCommand[]) {
      expect(
        checkCommandIdentity({
          command,
          controlledTab: { ...controlledTab, adopted: true },
          observedTab: null,
          snapshot: null,
        }),
      ).toEqual({ status: "tab-changed" });
    }
  });

  test("going back needs the latest snapshot the web client saw", () => {
    expect(
      checkCommandIdentity({
        command: { action: "go-back" },
        controlledTab,
        observedTab: { ...observedTab, revision: "revision-0" },
        snapshot,
      }),
    ).toEqual({ status: "stale-snapshot" });
  });
});
