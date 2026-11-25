import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";
import {
  BROWSER_STEP_GATE,
  decideBrowserStep,
} from "@stll/api-contract/browser-step-gate";
import { CHAT_LOCAL_RUN_BROWSER_ACTIONS } from "@stll/api-contract/chat-local-run-tool";
import { DESKTOP_RUNNER_APPROVAL_MODES } from "@stll/api-contract/desktop-runner";

import {
  BROWSER_TOOLS_THAT_MAY_ASK,
  BROWSER_TOOLS_THAT_NEVER_ASK,
  MEMBER_WAIT_CALL_TIMEOUT_MS,
} from "./member-wait";

const SITE = "https://fixture-library.test";

/** The command each browser tool that never asks sends, as the tools build it. */
const NEVER_ASKING_COMMANDS = {
  snapshot: { action: BROWSER_CONTROL_ACTION.snapshot },
  find: {
    action: BROWSER_CONTROL_ACTION.find,
    search: { query: "x", type: "text" },
  },
  go_back: { action: BROWSER_CONTROL_ACTION.goBack },
  switch_tab: {
    action: BROWSER_CONTROL_ACTION.switchTab,
    tabId: 7,
    url: `${SITE}/`,
  },
} as const satisfies Record<string, BrowserControlCommand>;

describe("a tool call that may wait on the member", () => {
  test("every browser tool is either one that may ask or one that never does", () => {
    expect(
      [
        ...BROWSER_TOOLS_THAT_MAY_ASK,
        ...BROWSER_TOOLS_THAT_NEVER_ASK,
      ].toSorted(),
    ).toEqual([...CHAT_LOCAL_RUN_BROWSER_ACTIONS].toSorted());
    expect(Object.keys(NEVER_ASKING_COMMANDS).toSorted()).toEqual(
      [...BROWSER_TOOLS_THAT_NEVER_ASK].toSorted(),
    );
  });

  test("the tools left scriptable never ask at any permission level", () => {
    for (const command of Object.values(NEVER_ASKING_COMMANDS)) {
      for (const level of DESKTOP_RUNNER_APPROVAL_MODES) {
        const decision = decideBrowserStep({
          level,
          command,
          reportedPage: null,
          signIn: false,
          grantedOrigins: new Set(),
          visitedOrigins: new Set(),
        });
        expect(decision.type).not.toBe(BROWSER_STEP_GATE.ask);
      }
    }
  });

  test("opening a website the chat has not been on is one that asks", () => {
    expect(BROWSER_TOOLS_THAT_MAY_ASK).toContain("open");
    expect(
      decideBrowserStep({
        level: "ask",
        command: { action: BROWSER_CONTROL_ACTION.open, url: `${SITE}/` },
        reportedPage: null,
        signIn: false,
        grantedOrigins: new Set(),
        visitedOrigins: new Set(),
      }).type,
    ).toBe(BROWSER_STEP_GATE.ask);
  });

  test("the bound stays below what a Node timer can hold", () => {
    expect(MEMBER_WAIT_CALL_TIMEOUT_MS).toBeLessThan(2 ** 31 - 1);
  });
});
