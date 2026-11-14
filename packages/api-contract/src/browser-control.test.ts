import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlResult,
  formatElementReference,
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
  parseBrowserControlResult,
  parseBrowserDesktopRequest,
  parseBrowserDesktopResponse,
  parseBrowserExtensionPeerVersion,
  parseBrowserExtensionRequest,
  parseBrowserExtensionResponse,
  parseElementReference,
} from "./browser-control";

const PAGE = {
  revision: "revision-1",
  url: "https://example.com/",
} as const;
const ABSENT_TARGET_METADATA = {
  type: BROWSER_CONTROL_TARGET_METADATA.absent,
} as const;
const CURSOR = "r1.eyJrIjoicmVhZCJ9";
const TARGET = {
  context: ABSENT_TARGET_METADATA,
  href: ABSENT_TARGET_METADATA,
  name: "Submit",
  ref: "e:0:0.12.3",
  role: "button",
} as const;

const COMMAND_EXAMPLES = {
  [BROWSER_CONTROL_ACTION.click]: {
    action: "click",
    page: PAGE,
    target: {
      context: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: "Case 12 C 345/2024 Next",
      },
      href: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: "https://example.com/next",
      },
      name: "Next",
      ref: "e:0:1.s.0.2",
      role: "link",
    },
  },
  [BROWSER_CONTROL_ACTION.fill]: {
    action: "fill",
    page: PAGE,
    target: { ...TARGET, name: "Search", ref: "e:1:2", role: "textbox" },
    value: "search text",
  },
  [BROWSER_CONTROL_ACTION.goBack]: { action: "go-back" },
  [BROWSER_CONTROL_ACTION.open]: {
    action: "open",
    url: "https://example.com/",
  },
  [BROWSER_CONTROL_ACTION.pressKey]: {
    action: "press-key",
    key: "Enter",
    page: PAGE,
    target: { ...TARGET, name: "Search", ref: "e:2:0", role: "textbox" },
  },
  [BROWSER_CONTROL_ACTION.select]: {
    action: "select",
    page: PAGE,
    target: { ...TARGET, name: "Court", ref: "e:0:3.1", role: "select" },
    value: "option-1",
  },
  [BROWSER_CONTROL_ACTION.snapshot]: { action: "snapshot", cursor: CURSOR },
  [BROWSER_CONTROL_ACTION.find]: {
    action: "find",
    after: CURSOR,
    search: { query: "notice period", type: "text" },
  },
  [BROWSER_CONTROL_ACTION.switchTab]: {
    action: "switch-tab",
    tabId: 9,
    url: "https://example.com/opened",
  },
} as const satisfies Record<
  BrowserControlCommand["action"],
  BrowserControlCommand
>;

describe("element references", () => {
  test("round-trips frame and shadow-root paths", () => {
    expect(parseElementReference("e:0:0.12.3")).toEqual({
      frameId: 0,
      path: "0.12.3",
    });
    expect(parseElementReference("e:7:1.s.0.2")).toEqual({
      frameId: 7,
      path: "1.s.0.2",
    });
    expect(formatElementReference({ frameId: 7, path: "1.s.0.2" })).toBe(
      "e:7:1.s.0.2",
    );
  });

  test("rejects references that do not address one element in one frame", () => {
    for (const reference of [
      "e:0.12.3",
      "e:0:",
      "e:0:1.s",
      "e:0:s.1",
      "e:0:1.s.s.0",
      "e:a:1",
      "e:0:1:2",
      "#submit",
      `e:0:${"1.".repeat(BROWSER_CONTROL_LIMITS.referenceChars)}1`,
    ]) {
      expect(parseElementReference(reference)).toBeNull();
    }
  });
});

describe("browser control command contract", () => {
  test("exercises and accepts every declared action", () => {
    expect(Object.keys(COMMAND_EXAMPLES).toSorted()).toEqual(
      Object.values(BROWSER_CONTROL_ACTION).toSorted(),
    );
    for (const command of Object.values(COMMAND_EXAMPLES)) {
      expect(parseBrowserControlCommand(command)).toEqual(command);
    }
  });

  test("classifies reads separately from actions", () => {
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.snapshot)).toBe(true);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.find)).toBe(true);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES["go-back"])).toBe(false);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.open)).toBe(false);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.click)).toBe(false);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES["switch-tab"])).toBe(
      false,
    );
  });

  test("opens in a new tab only when asked with a boolean", () => {
    const newTab = { action: "open", newTab: true, url: PAGE.url } as const;
    expect(parseBrowserControlCommand(newTab)).toEqual(newTab);
    expect(parseBrowserControlCommand({ ...newTab, newTab: "yes" })).toBeNull();
  });

  test("switches only to a named tab at a named address", () => {
    expect(
      parseBrowserControlCommand({ action: "switch-tab", tabId: 9 }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "switch-tab",
        tabId: -1,
        url: PAGE.url,
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "switch-tab",
        tabId: 9,
        url: "",
      }),
    ).toBeNull();
  });

  test("rejects extra fields, malformed references and out-of-range offsets", () => {
    expect(
      parseBrowserControlCommand({
        action: "snapshot",
        javascript: "document.cookie",
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "click",
        page: PAGE,
        target: { name: "Submit", ref: "e:0:0.12.3", role: "button" },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "click",
        page: PAGE,
        target: {
          ...TARGET,
          href: {
            type: BROWSER_CONTROL_TARGET_METADATA.absent,
            value: "https://example.com/unapproved",
          },
        },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "click",
        page: PAGE,
        target: { ...TARGET, ref: "#submit" },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "click",
        page: PAGE,
        target: { ...TARGET, ref: "e:0.12.3" },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({ action: "snapshot", textOffset: 0 }),
    ).toBeNull();
  });

  test("takes only cursors the extension issues, and plain-text finds", () => {
    for (const cursor of [
      "",
      "e:0:1",
      "r1.",
      "r1.has spaces",
      `r1.${"a".repeat(BROWSER_CONTROL_LIMITS.cursorChars)}`,
    ]) {
      expect(
        parseBrowserControlCommand({ action: "snapshot", cursor }),
      ).toBeNull();
    }
    expect(
      parseBrowserControlCommand({
        action: "find",
        search: { query: "", type: "text" },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "find",
        search: {
          query: "x".repeat(BROWSER_CONTROL_LIMITS.findQueryChars + 1),
          type: "text",
        },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlCommand({
        action: "find",
        search: { pattern: "a.*b", query: "ab", type: "text" },
      }),
    ).toBeNull();
    const headings = { action: "find", search: { type: "headings" } } as const;
    expect(parseBrowserControlCommand(headings)).toEqual(headings);
  });
});

describe("browser control result contract", () => {
  const success = {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [
        {
          context: ABSENT_TARGET_METADATA,
          href: {
            type: BROWSER_CONTROL_TARGET_METADATA.present,
            value: "https://example.com/next",
          },
          id: "L1",
          name: "Next",
          ref: "e:0:0.1",
          role: "link",
        },
        {
          context: ABSENT_TARGET_METADATA,
          href: ABSENT_TARGET_METADATA,
          id: "E1",
          name: "Search",
          ref: "e:1:0.2.s.1",
          role: "textbox",
          value: "",
        },
      ],
      elementsLeftOut: false,
      facts: {
        canonicalUrl: "https://example.com/",
        language: "en",
        meta: [{ name: "citation_title", value: "Example" }],
      },
      revision: "revision-1",
      tabId: 7,
      tabs: [
        {
          active: true,
          tabId: 7,
          url: "https://example.com/",
        },
        {
          active: false,
          tabId: 9,
          url: "https://example.com/opened",
        },
      ],
      text: "Page text\nNext [L1]",
      title: "Example",
      url: "https://example.com/",
      window: {
        cursor: CURSOR,
        fromPercent: 0,
        next: CURSOR,
        toPercent: 12,
      },
    },
    status: "success",
  } satisfies BrowserControlResult;

  test("accepts a bounded snapshot", () => {
    expect(parseBrowserControlResult(success)).toEqual(success);
  });

  test("rejects two elements with one id", () => {
    const [link] = success.snapshot.elements;
    expect(
      parseBrowserControlResult({
        ...success,
        snapshot: {
          ...success.snapshot,
          elements: [link, { ...link, ref: "e:0:0.2" }],
        },
      }),
    ).toBeNull();
  });

  test("accepts find results bounded like a page", () => {
    const found = {
      found: {
        contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
        headings: [{ cursor: CURSOR, level: 2, text: "Scope" }],
        more: CURSOR,
        tabId: 7,
        title: "Example",
        type: "headings",
        url: "https://example.com/",
      },
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status: "found",
    } satisfies BrowserControlResult;
    expect(parseBrowserControlResult(found)).toEqual(found);
    expect(
      parseBrowserControlResult({
        ...found,
        found: {
          ...found.found,
          headings: [{ cursor: CURSOR, level: 7, text: "Scope" }],
        },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlResult({
        found: {
          contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
          matches: Array.from(
            { length: BROWSER_CONTROL_LIMITS.findMatches + 1 },
            () => ({ cursor: CURSOR, snippet: "notice" }),
          ),
          tabId: 7,
          title: "Example",
          total: 11,
          totalCapped: false,
          type: "text",
          url: "https://example.com/",
        },
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "found",
      }),
    ).toBeNull();
  });

  test("rejects oversized page output", () => {
    expect(
      parseBrowserControlResult({
        ...success,
        snapshot: {
          ...success.snapshot,
          text: "x".repeat(BROWSER_CONTROL_LIMITS.pageTextChars + 1),
        },
      }),
    ).toBeNull();
  });

  test("lists tabs by address only, never by title", () => {
    expect(
      parseBrowserControlResult({
        ...success,
        snapshot: {
          ...success.snapshot,
          tabs: [
            {
              active: false,
              tabId: 9,
              title: "Opened",
              url: "https://example.com/opened",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("lists no more tabs than chat may keep", () => {
    const tab = {
      active: false,
      tabId: 9,
      url: "https://example.com/opened",
    };
    expect(
      parseBrowserControlResult({
        ...success,
        snapshot: {
          ...success.snapshot,
          tabs: Array.from(
            { length: BROWSER_CONTROL_LIMITS.tabs + 1 },
            (_, index) => ({ ...tab, tabId: index }),
          ),
        },
      }),
    ).toBeNull();
    expect(
      parseBrowserControlResult({
        ...success,
        snapshot: {
          ...success.snapshot,
          tabs: [
            { ...tab, url: "x".repeat(BROWSER_CONTROL_LIMITS.urlChars + 1) },
          ],
        },
      }),
    ).toBeNull();
    const { tabs: _tabs, ...untabbed } = success.snapshot;
    expect(
      parseBrowserControlResult({ ...success, snapshot: untabbed }),
    ).toBeNull();
  });

  test("rejects malformed element references inside extension responses", () => {
    expect(
      parseBrowserExtensionResponse({
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "request-1",
        result: {
          ...success,
          snapshot: {
            ...success.snapshot,
            elements: [
              {
                context: ABSENT_TARGET_METADATA,
                href: ABSENT_TARGET_METADATA,
                id: "E1",
                name: "Submit",
                ref: "e:not-a-path",
                role: "button",
              },
            ],
          },
        },
        source: "stella-browser-extension",
        type: "command-result",
      }),
    ).toBeNull();
  });

  test("rejects a snapshot that does not name its tab", () => {
    const { tabId: _tabId, ...untabbed } = success.snapshot;
    expect(
      parseBrowserControlResult({ ...success, snapshot: untabbed }),
    ).toBeNull();
  });

  test("requires the controller, tool call, turn and observed tab on commands", () => {
    const command = {
      command: COMMAND_EXAMPLES.click,
      controllerId: "controller-1",
      observedTab: { revision: "revision-1", tabId: 7 },
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: "request-1",
      source: "stella-web",
      toolCallId: "tool-call-1",
      turnId: "turn-1",
      type: "command",
    } as const;
    expect(parseBrowserExtensionRequest(command)).not.toBeNull();
    expect(
      parseBrowserExtensionRequest({ ...command, observedTab: null }),
    ).not.toBeNull();
    for (const field of [
      "controllerId",
      "observedTab",
      "toolCallId",
      "turnId",
    ] as const) {
      const { [field]: _omitted, ...incomplete } = command;
      expect(parseBrowserExtensionRequest(incomplete)).toBeNull();
    }
  });

  test("a cancel names the controller and the turn it stops", () => {
    const cancel = {
      controllerId: "controller-1",
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: "request-2",
      source: "stella-web",
      turnId: "turn-1",
      type: "cancel",
    } as const;
    expect(parseBrowserExtensionRequest(cancel)).toEqual(cancel);
    const { turnId: _turnId, ...anyTurn } = cancel;
    expect(parseBrowserExtensionRequest(anyTurn)).toBeNull();
    expect(
      parseBrowserExtensionRequest({ ...cancel, toolCallId: "tool-call-1" }),
    ).toBeNull();
  });

  test("an extension status reports the controlled tab", () => {
    const pong = {
      allSitesGranted: true,
      controlledTabId: 7,
      controllerId: "controller-1",
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: "request-3",
      source: "stella-browser-extension",
      type: "pong",
    } as const;
    expect(parseBrowserExtensionResponse(pong)).toEqual(pong);
    const { controlledTabId: _tabId, ...previousVersion } = pong;
    expect(parseBrowserExtensionResponse(previousVersion)).toBeNull();
  });
});

describe("extension peer version", () => {
  test("reads the version of an extension message from another protocol", () => {
    const olderPong = {
      allSitesGranted: true,
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION - 1,
      requestId: "extension-ready",
      source: "stella-browser-extension",
      type: "pong",
    };
    expect(parseBrowserExtensionResponse(olderPong)).toBeNull();
    expect(parseBrowserExtensionPeerVersion(olderPong)).toBe(
      BROWSER_CONTROL_PROTOCOL_VERSION - 1,
    );
  });

  test.each([
    ["a stella page message", { protocolVersion: 3, source: "stella-web" }],
    ["no version", { source: "stella-browser-extension" }],
    [
      "a fractional version",
      { protocolVersion: 1.5, source: "stella-browser-extension" },
    ],
    ["not an object", "stella-browser-extension"],
  ])("ignores %s", (_name, input) => {
    expect(parseBrowserExtensionPeerVersion(input)).toBeNull();
  });
});

describe("stella desktop transport", () => {
  const command = {
    command: { action: "snapshot" },
    controllerId: "thread-1",
    observedTab: null,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: "request-1",
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
    toolCallId: "call-1",
    turnId: "run-1",
    type: "command",
  } as const;

  test("takes commands only from stella desktop, at this protocol", () => {
    expect(parseBrowserDesktopRequest(command)).toEqual(command);
    expect(
      parseBrowserDesktopRequest({
        ...command,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
      }),
    ).toBeNull();
    expect(
      parseBrowserDesktopRequest({
        ...command,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
      }),
    ).toBeNull();
  });

  test("reads a hello at any protocol, so a mismatch can be named", () => {
    for (const protocolVersion of [
      BROWSER_CONTROL_PROTOCOL_VERSION - 1,
      BROWSER_CONTROL_PROTOCOL_VERSION + 1,
    ]) {
      expect(
        parseBrowserDesktopRequest({
          protocolVersion,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
          type: "hello",
        }),
      ).not.toBeNull();
      expect(
        parseBrowserDesktopResponse({
          protocolVersion,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "hello",
        }),
      ).not.toBeNull();
    }
  });

  test("carries a sign-in refusal back as a result", () => {
    const response = {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: "request-1",
      result: {
        code: BROWSER_CONTROL_ERROR_CODE.needsMember,
        message: "This page asks for a sign-in.",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "error",
      },
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "command-result",
    } as const;
    expect(parseBrowserDesktopResponse(response)).toEqual(response);
  });
});
