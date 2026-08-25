import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlCommand,
  type BrowserControlResult,
  parseBrowserControlCommand,
  parseBrowserControlResult,
  parseBrowserExtensionResponse,
  parseBrowserExtensionRequest,
} from "./browser-control";

const PAGE = {
  revision: "revision-1",
  url: "https://example.com/",
} as const;
const TARGET = { name: "Submit", ref: "e:0.12.3", role: "button" } as const;

const COMMAND_EXAMPLES = {
  [BROWSER_CONTROL_ACTION.click]: {
    action: "click",
    page: PAGE,
    target: TARGET,
  },
  [BROWSER_CONTROL_ACTION.fill]: {
    action: "fill",
    page: PAGE,
    target: { name: "Search", ref: "e:1.2", role: "textbox" },
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
    target: { name: "Search", ref: "e:2.0", role: "textbox" },
  },
  [BROWSER_CONTROL_ACTION.select]: {
    action: "select",
    page: PAGE,
    target: { name: "Court", ref: "e:3.1", role: "select" },
    value: "option-1",
  },
  [BROWSER_CONTROL_ACTION.snapshot]: { action: "snapshot" },
} as const satisfies Record<
  BrowserControlCommand["action"],
  BrowserControlCommand
>;

describe("browser control command contract", () => {
  test("exercises and accepts every declared action", () => {
    expect(Object.keys(COMMAND_EXAMPLES).sort()).toEqual(
      Object.values(BROWSER_CONTROL_ACTION).sort(),
    );
    for (const command of Object.values(COMMAND_EXAMPLES)) {
      expect(parseBrowserControlCommand(command)).toEqual(command);
    }
  });

  test("rejects extra fields and malformed element references", () => {
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
  });
});

describe("browser control result contract", () => {
  const success = {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [{ name: "Submit", ref: "e:0.1", role: "button" }],
      revision: "revision-1",
      text: "Page text",
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
