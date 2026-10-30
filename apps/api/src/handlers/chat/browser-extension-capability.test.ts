import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_STATUS,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_EXTENSION_CAPABILITY,
  BROWSER_EXTENSION_PROTOCOL_MISMATCH,
  browserExtensionPolicy,
} from "./browser-extension-capability";

describe("browser extension capability policy", () => {
  test.each([
    {
      status: BROWSER_EXTENSION_STATUS.checking,
      guidance: "send the message again in a moment",
    },
    {
      status: BROWSER_EXTENSION_STATUS.notPaired,
      guidance:
        "extension icon in the browser toolbar on this stella tab and connect the tab",
    },
    {
      status: BROWSER_EXTENSION_STATUS.needsSiteAccess,
      guidance:
        "extension icon in the browser toolbar and allow website access",
    },
    {
      status: BROWSER_EXTENSION_STATUS.notInstalled,
      guidance:
        "install the stella browser extension for Chrome; the chat composer shows how",
    },
  ])("$status gives actionable guidance", ({ status, guidance }) => {
    const policy = browserExtensionPolicy({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      status,
    });
    expect(policy.toolOffered).toBe(false);
    expect(policy.promptLine).toContain(guidance);
  });
  test.each([
    BROWSER_CONTROL_PROTOCOL_VERSION - 1,
    BROWSER_CONTROL_PROTOCOL_VERSION + 1,
  ])(
    "protocol version %s disables tools and asks for a reload",
    (protocolVersion) => {
      for (const status of Object.values(BROWSER_EXTENSION_STATUS)) {
        const policy = browserExtensionPolicy({ protocolVersion, status });
        expect(policy.toolOffered).toBe(false);
        expect(policy.promptLine).toBe(
          "BROWSER: Tell the user, in their language, to reload this stella tab to use the browser extension. Do not claim you have no way to use a browser.",
        );
      }
    },
  );

  test("has one explicit tool and prompt decision for every status", () => {
    expect(Object.keys(BROWSER_EXTENSION_CAPABILITY).toSorted()).toEqual(
      [
        ...Object.values(BROWSER_EXTENSION_STATUS),
        BROWSER_EXTENSION_PROTOCOL_MISMATCH,
      ].toSorted(),
    );

    for (const status of Object.values(BROWSER_EXTENSION_STATUS)) {
      const policy = browserExtensionPolicy({
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status,
      });
      expect(policy.promptLine.length).toBeGreaterThan(0);
      if (!policy.toolOffered) {
        expect(policy.promptLine).toContain(
          "Do not claim you have no way to use a browser.",
        );
      }
      expect(policy.toolOffered).toBe(
        status === BROWSER_EXTENSION_STATUS.connected,
      );
    }
  });
});
