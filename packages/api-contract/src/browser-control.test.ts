import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlResult,
  formatElementReference,
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
  parseBrowserControlResult,
  parseBrowserExtensionResponse,
  parseBrowserExtensionRequest,
  parseElementReference,
} from "./browser-control";

const PAGE = {
  revision: "revision-1",
  url: "https://example.com/",
} as const;
const TARGET = { name: "Submit", ref: "e:0:0.12.3", role: "button" } as const;

const COMMAND_EXAMPLES = {
  [BROWSER_CONTROL_ACTION.click]: {
    action: "click",
    page: PAGE,
    target: {
      href: "https://example.com/next",
      name: "Next",
      ref: "e:0:1.s.0.2",
      role: "link",
    },
  },
  [BROWSER_CONTROL_ACTION.fill]: {
    action: "fill",
    page: PAGE,
    target: { name: "Search", ref: "e:1:2", role: "textbox" },
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
    target: { name: "Search", ref: "e:2:0", role: "textbox" },
  },
  [BROWSER_CONTROL_ACTION.select]: {
    action: "select",
    page: PAGE,
    target: { name: "Court", ref: "e:0:3.1", role: "select" },
    value: "option-1",
  },
  [BROWSER_CONTROL_ACTION.snapshot]: { action: "snapshot", textOffset: 48_000 },
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
    expect(Object.keys(COMMAND_EXAMPLES).sort()).toEqual(
      Object.values(BROWSER_CONTROL_ACTION).sort(),
    );
    for (const command of Object.values(COMMAND_EXAMPLES)) {
      expect(parseBrowserControlCommand(command)).toEqual(command);
    }
  });

  test("classifies reads separately from actions", () => {
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.snapshot)).toBe(true);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES["go-back"])).toBe(true);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.open)).toBe(false);
    expect(isReadOnlyBrowserCommand(COMMAND_EXAMPLES.click)).toBe(false);
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
      parseBrowserControlCommand({
        action: "snapshot",
        textOffset: BROWSER_CONTROL_LIMITS.pageTextTotalChars + 1,
      }),
    ).toBeNull();
  });
});

describe("browser control result contract", () => {
  const success = {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [
        {
          href: "https://example.com/next",
          name: "Next",
          ref: "e:0:0.1",
          role: "link",
        },
        { name: "Search", ref: "e:1:0.2.s.1", role: "textbox", value: "" },
      ],
      revision: "revision-1",
      text: "Page text",
      textOffset: 0,
      textTotalChars: 9,
      title: "Example",
      url: "https://example.com/",
    },
    status: "success",
  } satisfies BrowserControlResult;

  test("accepts a bounded snapshot", () => {
    expect(parseBrowserControlResult(success)).toEqual(success);
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

  test("rejects malformed element references inside extension responses", () => {
    expect(
      parseBrowserExtensionResponse({
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "request-1",
        result: {
          ...success,
          snapshot: {
            ...success.snapshot,
            elements: [{ name: "Submit", ref: "e:not-a-path", role: "button" }],
          },
        },
        source: "stella-browser-extension",
        type: "command-result",
      }),
    ).toBeNull();
  });

  test("requires the controller and durable tool-call id on commands", () => {
    expect(
      parseBrowserExtensionRequest({
        command: COMMAND_EXAMPLES.click,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "request-1",
        source: "stella-web",
        type: "command",
      }),
    ).toBeNull();
    expect(
      parseBrowserExtensionRequest({
        command: COMMAND_EXAMPLES.click,
        controllerId: "controller-1",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: "request-1",
        source: "stella-web",
        toolCallId: "tool-call-1",
        type: "command",
      }),
    ).not.toBeNull();
  });
});
