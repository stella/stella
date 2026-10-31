import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionCapability,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";

type BrowserExtensionPolicy = {
  promptLine: string;
  toolOffered: boolean;
};

/**
 * What the model may relay to the user when browser tools are missing. It is
 * the clause after "tell them, in their language,", so a row names only the
 * recovery step and never the instruction to speak; the composer owns when
 * the step may be mentioned at all.
 */
type BrowserRecoveryStep = `to ${string}` | `that ${string}`;

type BrowserExtensionRow =
  | {
      toolOffered: true;
      /** What is true this turn, including when to use the tools. */
      availability: string;
    }
  | {
      toolOffered: false;
      /** What is true this turn; a statement, never an instruction. */
      availability: string;
      recoveryStep: BrowserRecoveryStep;
    };

export const BROWSER_EXTENSION_PROTOCOL_MISMATCH = "protocol-mismatch";

export const BROWSER_EXTENSION_CAPABILITY = {
  [BROWSER_EXTENSION_PROTOCOL_MISMATCH]: {
    toolOffered: false,
    availability:
      "Browser tools are not available in this chat because this stella tab and the browser extension run different versions.",
    recoveryStep: "to reload this stella tab to use the browser extension",
  },
  [BROWSER_EXTENSION_STATUS.checking]: {
    toolOffered: false,
    availability:
      "Browser tools are not available yet because the browser extension state is still loading.",
    recoveryStep: "to send the message again in a moment",
  },
  [BROWSER_EXTENSION_STATUS.connected]: {
    toolOffered: true,
    availability:
      "Browser tools are available for this turn. Use them when the user asks you to operate a website.",
  },
  [BROWSER_EXTENSION_STATUS.needsSiteAccess]: {
    toolOffered: false,
    availability:
      "Browser tools are not available in this chat because the stella browser extension has no website access.",
    recoveryStep:
      "to click the stella extension icon in the browser toolbar and allow website access",
  },
  [BROWSER_EXTENSION_STATUS.notInstalled]: {
    toolOffered: false,
    availability:
      "Browser tools are not available in this chat because the stella browser extension is not installed.",
    recoveryStep:
      "to install the stella browser extension for Chrome, as the chat composer shows",
  },
  [BROWSER_EXTENSION_STATUS.notPaired]: {
    toolOffered: false,
    availability:
      "Browser tools are not available in this chat because this stella tab is not connected to the browser extension.",
    recoveryStep:
      "to click the stella extension icon in the browser toolbar on this stella tab and connect the tab",
  },
  [BROWSER_EXTENSION_STATUS.unsupportedBrowser]: {
    toolOffered: false,
    availability:
      "Browser tools are not available in this chat because this browser cannot run the stella browser extension.",
    recoveryStep:
      "that browser control requires a browser that supports the stella Chrome extension",
  },
} satisfies Record<
  BrowserExtensionStatus | typeof BROWSER_EXTENSION_PROTOCOL_MISMATCH,
  BrowserExtensionRow
>;

/**
 * The only place a browser row becomes prompt text. A missing-tools row is
 * wrapped so the model raises the recovery step only when the user asks for
 * a website; an ordinary request never hears about the extension.
 */
export const composeBrowserExtensionPromptLine = (
  row: BrowserExtensionRow,
): string =>
  row.toolOffered
    ? `BROWSER: ${row.availability}`
    : `BROWSER: ${row.availability} Only if the user asks you to open, read or operate a website, tell them, in their language, ${row.recoveryStep}; otherwise do not mention the browser extension. Do not claim you have no way to use a browser.`;

export const browserExtensionPolicy = (
  extension: BrowserExtensionCapability,
): BrowserExtensionPolicy => {
  const row: BrowserExtensionRow =
    BROWSER_EXTENSION_CAPABILITY[
      extension.protocolVersion === BROWSER_CONTROL_PROTOCOL_VERSION
        ? extension.status
        : BROWSER_EXTENSION_PROTOCOL_MISMATCH
    ];
  return {
    promptLine: composeBrowserExtensionPromptLine(row),
    toolOffered: row.toolOffered,
  };
};
