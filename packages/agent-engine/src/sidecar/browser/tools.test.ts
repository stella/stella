import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserObservedTab,
} from "@stll/api-contract/browser-control";
import {
  CHAT_LOCAL_RUN_BROWSER_ACTIONS,
  CHAT_LOCAL_RUN_NEEDS_MEMBER,
  CHAT_LOCAL_RUN_TOOL_NAMES,
  shownChatLocalRunToolResult,
} from "@stll/api-contract/chat-local-run-tool";

import { localBrowserResult } from "./local-result";
import { createLocalBrowserSession, localBrowserToolList } from "./tools";

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;

const page = (revision: string): BrowserControlResult => ({
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [
      {
        context: ABSENT,
        href: ABSENT,
        name: "Search",
        ref: "e:0:1.0",
        role: "textbox",
      },
      {
        context: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: "Row 1",
        },
        href: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: "https://fixture-library.test/doc/1",
        },
        name: "Decision 1",
        ref: "e:0:2.0",
        role: "link",
      },
    ],
    revision,
    tabId: 7,
    tabs: [],
    text: "Results",
    textOffset: 0,
    textTotalChars: 7,
    title: "Fixture library",
    url: "https://fixture-library.test/search",
  },
  status: "success",
});

type Sent = {
  command: BrowserControlCommand;
  observedTab: BrowserObservedTab | null;
};

const recorder = (results: BrowserControlResult[]) => {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (
      command: BrowserControlCommand,
      observedTab: BrowserObservedTab | null,
    ) => {
      sent.push({ command, observedTab });
      return localBrowserResult(results.shift() ?? page("unexpected"));
    },
  };
};

const parsed = (result: { content: { text: string }[] }): unknown =>
  JSON.parse(result.content.at(0)?.text ?? "null");

describe("the local browser tools", () => {
  test("list exactly the four actions chat knows", () => {
    expect(localBrowserToolList().map(({ name }) => name)).toEqual([
      ...CHAT_LOCAL_RUN_BROWSER_ACTIONS,
    ]);
  });

  test("click and type address the exact page the chat last read", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2"), page("r-3")]);

    const read = await session.call("snapshot", {}, browser.send);
    expect(read.isError).toBe(false);
    expect(parsed(read)).toMatchObject({
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [
        { name: "Search", ref: "e:0:1.0", role: "textbox" },
        {
          context: "Row 1",
          href: "https://fixture-library.test/doc/1",
          ref: "e:0:2.0",
        },
      ],
    });

    await session.call(
      "type",
      { ref: "e:0:1.0", text: "notice" },
      browser.send,
    );
    await session.call("click", { ref: "e:0:2.0" }, browser.send);
    expect(browser.sent).toEqual([
      { command: { action: "snapshot" }, observedTab: null },
      {
        command: {
          action: "fill",
          page: { revision: "r-1", url: "https://fixture-library.test/search" },
          target: {
            context: ABSENT,
            href: ABSENT,
            name: "Search",
            ref: "e:0:1.0",
            role: "textbox",
          },
          value: "notice",
        },
        observedTab: { revision: "r-1", tabId: 7 },
      },
      {
        command: {
          action: "click",
          page: { revision: "r-2", url: "https://fixture-library.test/search" },
          target: {
            context: {
              type: BROWSER_CONTROL_TARGET_METADATA.present,
              value: "Row 1",
            },
            href: {
              type: BROWSER_CONTROL_TARGET_METADATA.present,
              value: "https://fixture-library.test/doc/1",
            },
            name: "Decision 1",
            ref: "e:0:2.0",
            role: "link",
          },
        },
        observedTab: { revision: "r-2", tabId: 7 },
      },
    ]);
  });

  test("a ref the chat never read is refused without reaching Chrome", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([]);
    const result = await session.call("click", { ref: "e:0:9" }, browser.send);
    expect(result.isError).toBe(true);
    expect(parsed(result)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
      hint: "Call snapshot and use a ref from it.",
    });
    expect(browser.sent).toEqual([]);
  });

  test("a sign-in is the member's, and chat keeps only that", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([
      {
        code: BROWSER_CONTROL_ERROR_CODE.needsMember,
        message: "This page asks for a sign-in.",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "error",
      },
    ]);
    const result = await session.call(
      "open",
      { url: "https://fixture-library.test/account" },
      browser.send,
    );
    expect(result.isError).toBe(true);
    expect(parsed(result)).toMatchObject({
      hint: expect.stringContaining("sign in"),
      status: CHAT_LOCAL_RUN_NEEDS_MEMBER,
    });
    expect(
      shownChatLocalRunToolResult(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        result.content.at(0)?.text ?? "",
        true,
      ),
    ).toBe(JSON.stringify({ status: CHAT_LOCAL_RUN_NEEDS_MEMBER }));
  });

  test("a page read is kept as completed, never as its content", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1")]);
    const result = await session.call("snapshot", {}, browser.send);
    expect(
      shownChatLocalRunToolResult(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        result.content.at(0)?.text ?? "",
        false,
      ),
    ).toBe(JSON.stringify({ status: "completed" }));
  });

  test("input a model fills too generously still reads", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1")]);
    await session.call(
      "snapshot",
      { textOffset: null, extra: 1 },
      browser.send,
    );
    expect(browser.sent.at(0)?.command).toEqual({ action: "snapshot" });
    const refused = await session.call("open", { url: 42 }, browser.send);
    expect(parsed(refused)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });
  });
});
