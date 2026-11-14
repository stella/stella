import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlResult,
  type BrowserControlSnapshot,
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

/** `result`'s page with another element or the chat's tabs. */
const withPage = (
  result: BrowserControlResult,
  change: (snapshot: BrowserControlSnapshot) => BrowserControlSnapshot,
): BrowserControlResult =>
  result.status === "success"
    ? { ...result, snapshot: change(result.snapshot) }
    : result;

const COURT_SELECT = {
  context: ABSENT,
  href: ABSENT,
  id: "E2",
  name: "Court",
  ref: "e:0:3.0",
  role: "select",
  value: "",
} as const;

/** The search page with a court select beside the search field. */
const formPage = (revision: string) =>
  withPage(page(revision), (snapshot) => ({
    ...snapshot,
    elements: [...snapshot.elements, COURT_SELECT],
  }));

const SEARCH_URL = "https://fixture-library.test/search";
const DECISION_URL = "https://fixture-library.test/doc/1";

const tabbed = (
  result: BrowserControlResult,
  tabs: BrowserControlSnapshot["tabs"],
) => withPage(result, (snapshot) => ({ ...snapshot, tabs }));

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

/** A question the member was asked, each kind with its own fields. */
type AskedStep<Request = BrowserApprovalRequest> = Request extends unknown
  ? Omit<Request, "signal">
  : never;

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
  const asked: AskedStep[] = [];
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

const SEARCH_TARGET = {
  context: ABSENT,
  href: ABSENT,
  name: "Search",
  ref: "e:0:1.0",
  role: "textbox",
} as const;

const COURT_TARGET = {
  context: ABSENT,
  href: ABSENT,
  name: "Court",
  ref: "e:0:3.0",
  role: "select",
} as const;

const NEEDS_MEMBER: BrowserControlResult = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "This page asks for a sign-in.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
};

describe("keys, options, history and tabs", () => {
  test("press_key presses an allowed key in the element the latest read listed", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2")], {
      approvals: "full_auto",
    });
    await session.call("snapshot", {}, browser.context);
    const pressed = await session.call(
      "press_key",
      { ref: "E1", key: "Enter" },
      browser.context,
    );
    expect(pressed.isError).toBe(false);
    expect(browser.sent.at(1)).toEqual({
      command: {
        action: "press-key",
        key: "Enter",
        page: { revision: "r-1", url: SEARCH_URL },
        target: SEARCH_TARGET,
      },
      observedTab: { revision: "r-1", tabId: 7 },
    });
  });

  test("press_key refuses a key outside the list and a ref the read did not list, without reaching Chrome", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1")], { approvals: "full_auto" });
    await session.call("snapshot", {}, browser.context);
    const backspace = await session.call(
      "press_key",
      { ref: "E1", key: "Backspace" },
      browser.context,
    );
    expect(parsed(backspace)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      message: expect.stringContaining(
        "Enter, Escape, Tab, ArrowDown, ArrowUp",
      ),
    });
    const unlisted = await session.call(
      "press_key",
      { ref: "E9", key: "Enter" },
      browser.context,
    );
    expect(parsed(unlisted)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
    });
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
    ]);
  });

  test("select sends the option the agent named, as a label or a value", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([formPage("r-1"), formPage("r-2")], {
      approvals: "full_auto",
    });
    await session.call("snapshot", {}, browser.context);
    await session.call(
      "select",
      { ref: "E2", option: "Supreme Court" },
      browser.context,
    );
    expect(browser.sent.at(1)?.command).toEqual({
      action: "select",
      page: { revision: "r-1", url: SEARCH_URL },
      target: COURT_TARGET,
      value: "Supreme Court",
    });
    const empty = await session.call(
      "select",
      { ref: "E2", option: "" },
      browser.context,
    );
    expect(parsed(empty)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });
    expect(browser.sent).toHaveLength(2);
  });

  test("go_back goes back one page, with or without empty input", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2")]);
    await session.call("go_back", undefined, browser.context);
    await session.call("go_back", {}, browser.context);
    expect(browser.sent.map(({ command }) => command)).toEqual([
      { action: "go-back" },
      { action: "go-back" },
    ]);
  });

  test("open opens a new tab only when asked to", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([page("r-1"), page("r-2"), page("r-3")]);
    await session.call(
      "open",
      { url: DECISION_URL, newTab: true },
      browser.context,
    );
    await session.call(
      "open",
      { url: DECISION_URL, newTab: false },
      browser.context,
    );
    await session.call("open", { url: DECISION_URL }, browser.context);
    expect(browser.sent.map(({ command }) => command)).toEqual([
      { action: "open", newTab: true, url: DECISION_URL },
      { action: "open", url: DECISION_URL },
      { action: "open", url: DECISION_URL },
    ]);
  });

  test("a read lists the chat's tabs only when it has more than one", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([
      tabbed(page("r-1"), [{ active: true, tabId: 7, url: SEARCH_URL }]),
      tabbed(page("r-2"), [
        { active: true, tabId: 7, url: SEARCH_URL },
        { active: false, tabId: 9, url: DECISION_URL },
      ]),
    ]);
    const one = parsed(await session.call("snapshot", {}, browser.context));
    expect(one).not.toHaveProperty("tabs");
    const two = parsed(await session.call("snapshot", {}, browser.context));
    expect(two).toMatchObject({
      tabs: [
        { active: true, tabId: 7, url: SEARCH_URL },
        { active: false, tabId: 9, url: DECISION_URL, opened: true },
      ],
    });
  });

  test("a click that opens a tab reports it once, and switch_tab moves there", async () => {
    const session = createLocalBrowserSession();
    const bothTabs = [
      { active: true, tabId: 7, url: SEARCH_URL },
      { active: false, tabId: 9, url: DECISION_URL },
    ];
    const browser = recorder(
      [
        tabbed(page("r-1"), [{ active: true, tabId: 7, url: SEARCH_URL }]),
        tabbed(page("r-2"), bothTabs),
        tabbed(page("r-3"), bothTabs),
        withPage(page("r-4"), (snapshot) => ({
          ...snapshot,
          tabId: 9,
          tabs: [
            { active: true, tabId: 9, url: DECISION_URL },
            { active: false, tabId: 7, url: SEARCH_URL },
          ],
          url: DECISION_URL,
        })),
      ],
      { approvals: "full_auto" },
    );
    await session.call("snapshot", {}, browser.context);
    const clicked = parsed(
      await session.call("click", { ref: "L1" }, browser.context),
    );
    expect(clicked).toMatchObject({
      tabs: [
        { tabId: 7, active: true },
        { tabId: 9, active: false, opened: true },
      ],
    });
    // The next read knows the tab: it is no longer new.
    const again = parsed(await session.call("snapshot", {}, browser.context));
    expect(again).toMatchObject({
      tabs: [{ tabId: 7 }, { tabId: 9 }],
    });
    expect(JSON.stringify(again)).not.toContain("opened");

    const switched = parsed(
      await session.call("switch_tab", { tabId: 9 }, browser.context),
    );
    expect(browser.sent.at(3)).toEqual({
      command: { action: "switch-tab", tabId: 9, url: DECISION_URL },
      observedTab: { revision: "r-3", tabId: 7 },
    });
    expect(switched).toMatchObject({ url: DECISION_URL });
    // Element refs now address the tab switched to.
    await session.call("click", { ref: "L1" }, browser.context);
    expect(browser.sent.at(4)).toMatchObject({
      command: { action: "click", page: { revision: "r-4" } },
      observedTab: { revision: "r-4", tabId: 9 },
    });
  });

  test("switch_tab takes only a tab the latest read listed", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([
      tabbed(page("r-1"), [{ active: true, tabId: 7, url: SEARCH_URL }]),
    ]);
    const before = await session.call(
      "switch_tab",
      { tabId: 9 },
      browser.context,
    );
    expect(parsed(before)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      hint: "Call snapshot and use a tabId from its tabs.",
    });
    await session.call("snapshot", {}, browser.context);
    const unlisted = await session.call(
      "switch_tab",
      { tabId: 9 },
      browser.context,
    );
    expect(unlisted.isError).toBe(true);
    const malformed = await session.call(
      "switch_tab",
      { tabId: "9" },
      browser.context,
    );
    expect(parsed(malformed)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
    ]);
  });

  test("no step gets past a sign-in: the member signs in, and chat keeps only that", async () => {
    for (const [tool, input] of [
      ["press_key", { ref: "E1", key: "Enter" }],
      ["select", { ref: "E2", option: "Supreme Court" }],
      ["go_back", {}],
      ["switch_tab", { tabId: 9 }],
      ["open", { url: DECISION_URL, newTab: true }],
    ] as const) {
      const session = createLocalBrowserSession();
      const browser = recorder(
        [
          tabbed(formPage("r-1"), [
            { active: true, tabId: 7, url: SEARCH_URL },
            { active: false, tabId: 9, url: DECISION_URL },
          ]),
          NEEDS_MEMBER,
        ],
        { approvals: "full_auto" },
      );
      await session.call("snapshot", {}, browser.context);
      const result = await session.call(tool, input, browser.context);
      expect({ tool, result: parsed(result) }).toMatchObject({
        tool,
        result: {
          hint: expect.stringContaining("sign in"),
          status: CHAT_LOCAL_RUN_NEEDS_MEMBER,
        },
      });
      expect(
        shownChatLocalRunToolResult(
          CHAT_LOCAL_RUN_TOOL_NAMES.browser,
          result.content.at(0)?.text ?? "",
          true,
        ),
      ).toBe(JSON.stringify({ status: CHAT_LOCAL_RUN_NEEDS_MEMBER }));
    }
  });
});

describe("keys, options, history and tabs by the run's approval mode", () => {
  type Step = "press_key" | "select" | "go_back" | "switch_tab";

  const INPUTS = {
    press_key: { ref: "E1", key: "Enter" },
    select: { ref: "E2", option: "Supreme Court" },
    go_back: {},
    switch_tab: { tabId: 9 },
  } as const satisfies Record<Step, unknown>;

  const SENT = {
    press_key: "press-key",
    select: "select",
    go_back: "go-back",
    switch_tab: "switch-tab",
  } as const satisfies Record<Step, BrowserControlCommand["action"]>;

  /** What each step does in each mode: runs, asks first, or is refused. */
  const GATES = {
    plan: {
      press_key: "refuse",
      select: "refuse",
      go_back: "run",
      switch_tab: "run",
    },
    ask: { press_key: "ask", select: "ask", go_back: "run", switch_tab: "run" },
    auto: {
      press_key: "run",
      select: "ask",
      go_back: "run",
      switch_tab: "run",
    },
    full_auto: {
      press_key: "run",
      select: "run",
      go_back: "run",
      switch_tab: "run",
    },
  } as const satisfies Record<
    DesktopRunnerApprovalMode,
    Record<Step, "run" | "ask" | "refuse">
  >;

  const MODES = [
    "plan",
    "ask",
    "auto",
    "full_auto",
  ] as const satisfies readonly DesktopRunnerApprovalMode[];
  const STEPS = [
    "press_key",
    "select",
    "go_back",
    "switch_tab",
  ] as const satisfies readonly Step[];

  const CASES = MODES.flatMap((approvals) =>
    STEPS.map((step) => ({ approvals, gate: GATES[approvals][step], step })),
  );

  test.each(CASES)(
    "$approvals: $step is $gate",
    async ({ approvals, gate, step }) => {
      const session = createLocalBrowserSession();
      const browser = recorder(
        [
          tabbed(formPage("r-1"), [
            { active: true, tabId: 7, url: SEARCH_URL },
            { active: false, tabId: 9, url: DECISION_URL },
          ]),
          formPage("r-2"),
        ],
        { approvals },
      );
      await session.call("snapshot", {}, browser.context);
      const result = await session.call(step, INPUTS[step], browser.context);
      const askedAbout: string[] = browser.asked.map(({ action }) => action);
      expect(askedAbout).toEqual(gate === "ask" ? [step] : []);
      expect(browser.sent.map(({ command }) => command.action)).toEqual(
        gate === "refuse" ? ["snapshot"] : ["snapshot", SENT[step]],
      );
      expect(result.isError).toBe(gate === "refuse");
      if (gate === "refuse") {
        expect(parsed(result)).toMatchObject({
          code: BROWSER_CONTROL_ERROR_CODE.permissionDenied,
          message: expect.stringContaining("Plan mode is read-only"),
        });
      }
    },
  );

  test("the member is asked which key on which element, and which option", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder(
      [formPage("r-1"), formPage("r-2"), formPage("r-3")],
      {
        approvals: "ask",
      },
    );
    await session.call("snapshot", {}, browser.context);
    await session.call("press_key", INPUTS.press_key, browser.context);
    await session.call("select", INPUTS.select, browser.context);
    expect(browser.asked).toEqual([
      {
        action: "press_key",
        key: "Enter",
        name: "Search",
        role: "textbox",
        url: SEARCH_URL,
      },
      {
        action: "select",
        name: "Court",
        option: "Supreme Court",
        role: "select",
        url: SEARCH_URL,
      },
    ]);
    expect(browser.finished).toEqual(["completed", "completed"]);
  });

  test("a declined key press or option runs nothing", async () => {
    const session = createLocalBrowserSession();
    const browser = recorder([formPage("r-1")], {
      approvals: "ask",
      decision: APPROVAL_DECISION.deny,
    });
    await session.call("snapshot", {}, browser.context);
    const results = [
      await session.call("press_key", INPUTS.press_key, browser.context),
      await session.call("select", INPUTS.select, browser.context),
    ];
    expect(browser.sent.map(({ command }) => command.action)).toEqual([
      "snapshot",
    ]);
    for (const result of results) {
      expect(parsed(result)).toMatchObject({ status: "declined" });
    }
  });
});
