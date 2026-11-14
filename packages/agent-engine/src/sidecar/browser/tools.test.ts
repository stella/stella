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
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import type { BrowserDownloadOutcome } from "./downloads";
import { localBrowserResult } from "./local-result";
import {
  APPROVAL_DECISION,
  type BrowserApprovalRequest,
  createLocalBrowserSession,
  localBrowserToolList,
} from "./tools";

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const CURSOR = "r1.d2luZG93";
const NEXT_CURSOR = "r1.bmV4dA";
const MORE_CURSOR = "r1.bW9yZQ";

const page = (revision: string): BrowserControlResult => ({
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [
      {
        context: ABSENT,
        href: ABSENT,
        id: "E1",
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
        id: "L1",
        name: "Decision 1",
        ref: "e:0:2.0",
        role: "link",
      },
    ],
    elementsLeftOut: false,
    facts: { meta: [] },
    revision,
    tabId: 7,
    tabs: [],
    text: "Results\nDecision 1 [L1]",
    title: "Fixture library",
    url: "https://fixture-library.test/search",
    window: {
      cursor: CURSOR,
      fromPercent: 0,
      next: NEXT_CURSOR,
      toPercent: 40,
    },
  },
  status: "success",
});

const found = (): BrowserControlResult => ({
  found: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    matches: [{ cursor: NEXT_CURSOR, snippet: "the notice period runs" }],
    more: MORE_CURSOR,
    tabId: 7,
    title: "Fixture library",
    total: 12,
    totalCapped: false,
    type: "text",
    url: "https://fixture-library.test/search",
  },
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "found",
});

type Sent = {
  command: BrowserControlCommand;
  observedTab: BrowserObservedTab | null;
};

const recorder = (
  results: BrowserControlResult[],
  {
    approvals = "auto",
    decision = APPROVAL_DECISION.approve,
    downloads = [],
  }: {
    approvals?: DesktopRunnerApprovalMode;
    decision?: (typeof APPROVAL_DECISION)[keyof typeof APPROVAL_DECISION];
    /** What the chat's tab downloaded before the next result. */
    downloads?: BrowserDownloadOutcome[];
  } = {},
) => {
  const sent: Sent[] = [];
  const asked: Omit<BrowserApprovalRequest, "signal">[] = [];
  const finished: string[] = [];
  const context = {
    approvals,
    approve: async ({
      signal: _signal,
      ...request
    }: BrowserApprovalRequest) => {
      asked.push(request);
      return {
        decision,
        finish: (status: string) => {
          finished.push(status);
        },
      };
    },
    // Handed out once, as the MCP server's inbox does.
    downloads: async () => downloads.splice(0),
    send: async (
      command: BrowserControlCommand,
      observedTab: BrowserObservedTab | null,
    ) => {
      sent.push({ command, observedTab });
      return localBrowserResult(results.shift() ?? page("unexpected"));
    },
    signal: new AbortController().signal,
  };
  return { asked, context, downloads, finished, send: context.send, sent };
};

const parsed = (result: { content: { text: string }[] }): unknown =>
  JSON.parse(result.content.at(0)?.text ?? "null");

describe("the local browser tools", () => {
  test("list exactly the actions chat knows", () => {
    expect(localBrowserToolList().map(({ name }) => name)).toEqual([
      ...CHAT_LOCAL_RUN_BROWSER_ACTIONS,
    ]);
  });

  test("a click that downloaded a file reports it once, saved or refused", async () => {
    const session = createLocalBrowserSession();
    const saved: BrowserDownloadOutcome = {
      bytes: 2048,
      path: "Downloads/Decision 1.pdf",
      sourceUrl: "https://fixture-library.test/doc/1/file",
      status: "saved",
    };
    const refused: BrowserDownloadOutcome = {
      message: "The download is not a PDF; only PDFs are saved.",
      reason: "not_pdf",
      sourceUrl: "https://fixture-library.test/doc/1/other",
      status: "refused",
    };
    const browser = recorder([page("r-1"), page("r-2"), page("r-3")]);
    await session.call("snapshot", {}, browser.context);
    browser.downloads.push(saved, refused);

    const clicked = await session.call("click", { ref: "L1" }, browser.context);
    expect(parsed(clicked)).toMatchObject({
      downloads: [saved, refused],
      url: "https://fixture-library.test/search",
    });
    const again = await session.call("snapshot", {}, browser.context);
    expect(parsed(again)).not.toHaveProperty("downloads");
  });

  test("a find result carries the downloads that arrived meanwhile", async () => {
    const session = createLocalBrowserSession();
    const saved: BrowserDownloadOutcome = {
      bytes: 10,
      path: "Downloads/decision.pdf",
      sourceUrl: "https://fixture-library.test/file",
      status: "saved",
    };
    const browser = recorder([found()], { downloads: [saved] });
    const result = await session.call(
      "find",
      { query: "notice" },
      browser.context,
    );
    expect(parsed(result)).toMatchObject({
      downloads: [saved],
      matches: [{ snippet: "the notice period runs" }],
    });
  });

  test("a download rides along when the step itself failed", async () => {
    const session = createLocalBrowserSession();
    const saved: BrowserDownloadOutcome = {
      bytes: 10,
      path: "Downloads/download.pdf",
      sourceUrl: "https://fixture-library.test/file",
      status: "saved",
    };
    const browser = recorder(
      [
        {
          code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
          message: "Chrome did not report back in time.",
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          status: "error",
        },
      ],
      { downloads: [saved] },
    );

    const opened = await session.call(
      "open",
      { url: "https://fixture-library.test/file" },
      browser.context,
    );
    expect(opened.isError).toBe(true);
    expect(parsed(opened)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
      downloads: [saved],
    });
  });

  test("click and type address the exact page the chat last read", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2"), page("r-3")]);

    const read = await session.call("snapshot", {}, browser.context);
    expect(read.isError).toBe(false);
    expect(parsed(read)).toMatchObject({
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [
        { name: "Search", ref: "E1", role: "textbox" },
        {
          context: "Row 1",
          href: "https://fixture-library.test/doc/1",
          ref: "L1",
        },
      ],
    });

    await session.call("type", { ref: "E1", text: "notice" }, browser.context);
    await session.call("click", { ref: "L1" }, browser.context);
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
    const result = await session.call("click", { ref: "E9" }, browser.context);
    expect(result.isError).toBe(true);
    expect(parsed(result)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
      hint: "Call snapshot and use a ref from it.",
    });
    // The extension's own ref is not what the agent was shown.
    const byExtensionRef = await session.call(
      "click",
      { ref: "e:0:2.0" },
      browser.context,
    );
    expect(parsed(byExtensionRef)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
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
      browser.context,
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
    const result = await session.call("snapshot", {}, browser.context);
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
    await session.call("snapshot", { cursor: null, extra: 1 }, browser.context);
    expect(browser.sent.at(0)?.command).toEqual({ action: "snapshot" });
    const refused = await session.call("open", { url: 42 }, browser.context);
    expect(parsed(refused)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });
  });

  test("a read shows the window's cursors and links by the ids the text marks", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2")]);
    const first = parsed(await session.call("snapshot", {}, browser.context));
    expect(first).toMatchObject({
      text: "Results\nDecision 1 [L1]",
      window: { cursor: CURSOR, next: NEXT_CURSOR },
      elements: [{ ref: "E1" }, { ref: "L1", name: "Decision 1" }],
    });
    await session.call("snapshot", { cursor: NEXT_CURSOR }, browser.context);
    expect(browser.sent.at(1)?.command).toEqual({
      action: "snapshot",
      cursor: NEXT_CURSOR,
    });
  });

  test("find sends plain text or a headings request, and needs one of them", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([found(), found(), found()]);
    const result = await session.call(
      "find",
      { query: "  notice period " },
      browser.context,
    );
    expect(result.isError).toBe(false);
    expect(parsed(result)).toEqual({
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      matches: [{ cursor: NEXT_CURSOR, snippet: "the notice period runs" }],
      more: MORE_CURSOR,
      title: "Fixture library",
      total: 12,
      url: "https://fixture-library.test/search",
    });
    await session.call(
      "find",
      { headings: true, after: MORE_CURSOR },
      browser.context,
    );
    await session.call(
      "find",
      { headings: true, query: "Scope" },
      browser.context,
    );
    expect(browser.sent.map(({ command }) => command)).toEqual([
      {
        action: "find",
        search: { query: "notice period", type: "text" },
      },
      {
        action: "find",
        after: MORE_CURSOR,
        search: { type: "headings" },
      },
      {
        action: "find",
        search: { query: "Scope", type: "headings" },
      },
    ]);
    const empty = await session.call("find", { query: " " }, browser.context);
    expect(parsed(empty)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });
    expect(browser.sent).toHaveLength(3);
  });

  test("click takes only ids the latest read listed", async () => {
    const session = createLocalBrowserSession();
    const without = page("r-2");
    const browser = recorder([
      page("r-1"),
      without.status === "success"
        ? {
            ...without,
            snapshot: {
              ...without.snapshot,
              elements: without.snapshot.elements.filter(
                ({ id }) => id !== "L1",
              ),
            },
          }
        : without,
    ]);
    await session.call("snapshot", {}, browser.context);
    await session.call("snapshot", { cursor: NEXT_CURSOR }, browser.context);
    const refused = await session.call("click", { ref: "L1" }, browser.context);
    expect(parsed(refused)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
    });
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
      "snapshot",
    ]);
  });

  test("find keeps the page click and type address", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), found(), page("r-2")]);
    await session.call("snapshot", {}, browser.context);
    await session.call("find", { query: "notice" }, browser.context);
    await session.call("click", { ref: "L1" }, browser.context);
    expect(browser.sent.at(2)).toMatchObject({
      command: { action: "click", page: { revision: "r-1" } },
      observedTab: { revision: "r-1", tabId: 7 },
    });
  });
});

describe("browser steps by the run's approval mode", () => {
  const searchPage = (revision: string): BrowserControlResult => {
    const base = page(revision);
    return base.status === "success"
      ? {
          ...base,
          snapshot: {
            ...base.snapshot,
            elements: base.snapshot.elements.map((element) =>
              element.ref === "e:0:1.0"
                ? { ...element, role: "searchbox" }
                : element,
            ),
          },
        }
      : base;
  };

  const SEARCH = { ref: "E1", text: "notice" } as const;
  const LINK = { ref: "L1" } as const;

  /** Reads the page, then opens, reads, types and clicks once each. */
  const steps = async (
    approvals: DesktopRunnerApprovalMode,
    field: "search" | "other",
  ) => {
    const read = field === "search" ? searchPage : page;
    const session = createLocalBrowserSession();
    const browser = recorder(
      [read("r-1"), read("r-2"), read("r-3"), read("r-4"), read("r-5")],
      { approvals },
    );
    await session.call("snapshot", {}, browser.context);
    await session.call(
      "open",
      { url: "https://fixture-library.test/search" },
      browser.context,
    );
    await session.call("snapshot", {}, browser.context);
    await session.call("type", SEARCH, browser.context);
    await session.call("click", LINK, browser.context);
    return browser;
  };

  const CASES = [
    { approvals: "ask", field: "search", asked: ["click"] },
    { approvals: "ask", field: "other", asked: ["type", "click"] },
    { approvals: "auto", field: "search", asked: [] },
    { approvals: "auto", field: "other", asked: ["type"] },
    { approvals: "full_auto", field: "search", asked: [] },
    { approvals: "full_auto", field: "other", asked: [] },
  ] as const satisfies readonly {
    approvals: DesktopRunnerApprovalMode;
    field: "search" | "other";
    asked: readonly ("click" | "type")[];
  }[];

  test("plan opens and reads, and refuses clicks and typing without asking", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2"), page("r-3")], {
      approvals: "plan",
    });
    await session.call("snapshot", {}, browser.context);
    const opened = await session.call(
      "open",
      { url: "https://fixture-library.test/search" },
      browser.context,
    );
    expect(opened.isError).toBe(false);
    await session.call("snapshot", {}, browser.context);
    const refused = [
      await session.call("type", SEARCH, browser.context),
      await session.call("type", { ref: "E1", text: "x" }, browser.context),
      await session.call("click", LINK, browser.context),
    ];
    expect(browser.asked).toEqual([]);
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
      "open",
      "snapshot",
    ]);
    for (const result of refused) {
      expect(result.isError).toBe(true);
      expect(parsed(result)).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.permissionDenied,
        message: expect.stringContaining("Plan mode is read-only"),
      });
      expect(
        shownChatLocalRunToolResult(
          CHAT_LOCAL_RUN_TOOL_NAMES.browser,
          result.content.at(0)?.text ?? "",
          true,
        ),
      ).toBe(JSON.stringify({ status: "failed" }));
    }
  });

  for (const { approvals, asked, field } of CASES) {
    test(`${approvals}: a ${field} field asks before ${asked.join(", ") || "nothing"}`, async () => {
      const browser = await steps(approvals, field);
      expect(browser.asked.map(({ action }) => action)).toEqual([...asked]);
      expect(browser.finished).toEqual(asked.map(() => "completed"));
      expect(browser.sent.map(({ command }) => command.action)).toEqual([
        "snapshot",
        "open",
        "snapshot",
        "fill",
        "click",
      ]);
    });
  }

  test("the member sees the element's role and name and the page address", async () => {
    const browser = await steps("ask", "other");
    expect(browser.asked).toEqual([
      {
        action: "type",
        name: "Search",
        role: "textbox",
        url: "https://fixture-library.test/search",
      },
      {
        action: "click",
        name: "Decision 1",
        role: "link",
        url: "https://fixture-library.test/search",
      },
    ]);
  });

  test("a refusal runs nothing and reads as declined", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1")], {
      approvals: "ask",
      decision: APPROVAL_DECISION.deny,
    });
    await session.call("snapshot", {}, browser.context);
    const typed = await session.call("type", SEARCH, browser.context);
    const clicked = await session.call("click", LINK, browser.context);
    expect(browser.asked.map(({ action }) => action)).toEqual([
      "type",
      "click",
    ]);
    expect(browser.finished).toEqual([]);
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
    ]);
    for (const refused of [typed, clicked]) {
      expect(refused.isError).toBe(true);
      expect(
        shownChatLocalRunToolResult(
          CHAT_LOCAL_RUN_TOOL_NAMES.browser,
          refused.content.at(0)?.text ?? "",
          true,
        ),
      ).toBe(JSON.stringify({ status: "declined" }));
    }
  });

  test("reading and finding never ask, in any mode", async () => {
    for (const approvals of ["plan", "ask"] as const) {
      const session = createLocalBrowserSession();
      const browser = recorder([page("r-1"), found(), found()], { approvals });
      await session.call("snapshot", {}, browser.context);
      await session.call("find", { query: "notice" }, browser.context);
      await session.call("find", { headings: true }, browser.context);
      expect(browser.asked).toEqual([]);
      expect(browser.sent.map(({ command }) => command.action)).toEqual([
        "snapshot",
        "find",
        "find",
      ]);
    }
  });

  test("an approved step that failed is reported failed", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder(
      [
        page("r-1"),
        {
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          status: "error",
          code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
          message: "Gone.",
        },
      ],
      { approvals: "ask" },
    );
    await session.call("snapshot", {}, browser.context);
    await session.call("click", LINK, browser.context);
    expect(browser.finished).toEqual(["failed"]);
  });
});
