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
      expect(policy.toolOffered).toBe(
        status === BROWSER_EXTENSION_STATUS.connected,
      );
    }
  });
});
