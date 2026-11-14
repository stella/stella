import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_KEYS,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_DESKTOP_KEYS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import { desktopCommandRefusal } from "./desktop-commands";

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const PAGE = { revision: "revision-1", url: "https://example.com/" } as const;
const target = (role: string) => ({
  context: ABSENT,
  href: ABSENT,
  name: "Court",
  ref: "e:0:1",
  role,
});

const pressKey = (key: (typeof BROWSER_CONTROL_KEYS)[number]) =>
  ({
    action: BROWSER_CONTROL_ACTION.pressKey,
    key,
    page: PAGE,
    target: target("searchbox"),
  }) satisfies BrowserControlCommand;

/** One command of every action the contract has. */
const EVERY_ACTION = {
  [BROWSER_CONTROL_ACTION.click]: {
    action: BROWSER_CONTROL_ACTION.click,
    page: PAGE,
    target: target("button"),
  },
  [BROWSER_CONTROL_ACTION.fill]: {
    action: BROWSER_CONTROL_ACTION.fill,
    page: PAGE,
    target: target("searchbox"),
    value: "notice period",
  },
  [BROWSER_CONTROL_ACTION.find]: {
    action: BROWSER_CONTROL_ACTION.find,
    search: { query: "notice", type: "text" },
  },
  [BROWSER_CONTROL_ACTION.goBack]: { action: BROWSER_CONTROL_ACTION.goBack },
  [BROWSER_CONTROL_ACTION.open]: {
    action: BROWSER_CONTROL_ACTION.open,
    newTab: true,
    url: "https://example.com/",
  },
  [BROWSER_CONTROL_ACTION.pressKey]: pressKey("Enter"),
  [BROWSER_CONTROL_ACTION.select]: {
    action: BROWSER_CONTROL_ACTION.select,
    page: PAGE,
    target: target("select"),
    value: "Supreme Court",
  },
  [BROWSER_CONTROL_ACTION.snapshot]: {
    action: BROWSER_CONTROL_ACTION.snapshot,
  },
  [BROWSER_CONTROL_ACTION.switchTab]: {
    action: BROWSER_CONTROL_ACTION.switchTab,
    tabId: 12,
    url: "https://example.com/decision",
  },
} as const satisfies {
  [Action in BrowserControlCommand["action"]]: Extract<
    BrowserControlCommand,
    { action: Action }
  >;
};

describe("commands from stella desktop", () => {
  test.each(Object.values(EVERY_ACTION))("$action is accepted", (command) => {
    expect(desktopCommandRefusal(command)).toBeNull();
  });

  test.each([...BROWSER_DESKTOP_KEYS])("the key %s is accepted", (key) => {
    expect(desktopCommandRefusal(pressKey(key))).toBeNull();
  });

  const otherKeys = BROWSER_CONTROL_KEYS.filter(
    (key) => !BROWSER_DESKTOP_KEYS.some((allowed) => allowed === key),
  );

  test("leave some contract keys outside the desktop's list", () => {
    expect(otherKeys).toEqual([
      "ArrowLeft",
      "ArrowRight",
      "Backspace",
      "Space",
    ]);
  });

  test.each(otherKeys)(
    "the key %s is refused, naming the keys it takes",
    (key) => {
      expect(desktopCommandRefusal(pressKey(key))).toBe(
        "stella desktop presses only Enter, Escape, Tab, ArrowDown, ArrowUp.",
      );
    },
  );
});
