import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_STATUS,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_EXTENSION_CAPABILITY,
  BROWSER_EXTENSION_PROTOCOL_MISMATCH,
  browserExtensionPolicy,
  composeBrowserExtensionPromptLine,
} from "./browser-extension-capability";

const ASKED_FOR_A_WEBSITE =
  "Only if the user asks you to open, read or operate a website, tell them, in their language, ";
const OTHERWISE_SILENT =
  "; otherwise do not mention the browser extension. Do not claim you have no way to use a browser.";
// A row speaking to the user on its own would reach every turn unconditionally.
const IMPERATIVE_TO_THE_USER =
  /^(?:tell|ask|instruct|explain|say|let|remind|install|click|reload|send)\b/iu;

const ALL_ROWS = Object.entries(BROWSER_EXTENSION_CAPABILITY);

describe("browser extension capability policy", () => {
  test.each([
    {
      status: BROWSER_EXTENSION_STATUS.checking,
      guidance: "to send the message again in a moment",
    },
    {
      status: BROWSER_EXTENSION_STATUS.notPaired,
      guidance:
        "to click the stella extension icon in the browser toolbar on this stella tab and connect the tab",
    },
    {
      status: BROWSER_EXTENSION_STATUS.needsSiteAccess,
      guidance:
        "to click the stella extension icon in the browser toolbar and allow website access",
    },
    {
      status: BROWSER_EXTENSION_STATUS.notInstalled,
      guidance:
        "to install the stella browser extension for Chrome, as the chat composer shows",
    },
    {
      status: BROWSER_EXTENSION_STATUS.unsupportedBrowser,
      guidance:
        "that browser control requires a browser that supports the stella Chrome extension",
    },
  ])(
    "$status keeps its recovery step behind a website request",
    ({ status, guidance }) => {
      const policy = browserExtensionPolicy({
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status,
      });
      expect(policy.toolOffered).toBe(false);
      expect(policy.promptLine).toContain(
        `${ASKED_FOR_A_WEBSITE}${guidance}${OTHERWISE_SILENT}`,
      );
    },
  );

  test.each([
    BROWSER_CONTROL_PROTOCOL_VERSION - 1,
    BROWSER_CONTROL_PROTOCOL_VERSION + 1,
  ])(
    "protocol version %s disables tools and offers a reload only on a website request",
    (protocolVersion) => {
      for (const status of Object.values(BROWSER_EXTENSION_STATUS)) {
        const policy = browserExtensionPolicy({ protocolVersion, status });
        expect(policy.toolOffered).toBe(false);
        expect(policy.promptLine).toBe(
          composeBrowserExtensionPromptLine(
            BROWSER_EXTENSION_CAPABILITY[BROWSER_EXTENSION_PROTOCOL_MISMATCH],
          ),
        );
        expect(policy.promptLine).toContain(
          `${ASKED_FOR_A_WEBSITE}to reload this stella tab to use the browser extension${OTHERWISE_SILENT}`,
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
      expect(policy.toolOffered).toBe(
        status === BROWSER_EXTENSION_STATUS.connected,
      );
    }
  });

  test.each(ALL_ROWS.filter(([, row]) => !row.toolOffered))(
    "%s composes a line that stays silent unless the user asks for a website",
    (_key, row) => {
      const line = composeBrowserExtensionPromptLine(row);
      expect(line.startsWith(`BROWSER: ${row.availability} `)).toBe(true);
      expect(line).toContain(ASKED_FOR_A_WEBSITE);
      expect(line.endsWith(OTHERWISE_SILENT)).toBe(true);
      // The conditional comes before any instruction to the user.
      expect(line.indexOf("Only if the user asks")).toBeLessThan(
        line.indexOf("tell them"),
      );
    },
  );

  test.each(ALL_ROWS)(
    "%s carries no unconditional instruction to the user in its raw text",
    (_key, row) => {
      const rawTexts =
        "recoveryStep" in row
          ? [row.availability, row.recoveryStep]
          : [row.availability];
      for (const text of rawTexts) {
        expect(text).not.toMatch(IMPERATIVE_TO_THE_USER);
        expect(text).not.toMatch(/\btell the user\b/iu);
        expect(text).not.toMatch(/\bask the user\b/iu);
      }
      if ("recoveryStep" in row) {
        expect(row.recoveryStep).toMatch(/^(?:to|that) /u);
      }
    },
  );

  test("the connected row keeps its availability line", () => {
    expect(
      browserExtensionPolicy({
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: BROWSER_EXTENSION_STATUS.connected,
      }).promptLine,
    ).toBe(
      "BROWSER: Browser tools are available for this turn. Use them when the user asks you to operate a website.",
    );
  });
});
