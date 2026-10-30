import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_STATUS,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_EXTENSION_CAPABILITY,
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
  test("has one explicit tool and prompt decision for every status", () => {
    expect(Object.keys(BROWSER_EXTENSION_CAPABILITY).toSorted()).toEqual(
      Object.values(BROWSER_EXTENSION_STATUS).toSorted(),
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
