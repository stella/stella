import {
  BROWSER_EXTENSION_STATUS,
  type BrowserExtensionCapability,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";

type BrowserExtensionPolicy = {
  promptLine: string;
  toolOffered: boolean;
};

export const BROWSER_EXTENSION_CAPABILITY = {
  [BROWSER_EXTENSION_STATUS.connected]: {
    toolOffered: true,
    promptLine:
      "BROWSER: Browser tools are available for this turn. Use them when the user asks you to operate a website.",
  },
  [BROWSER_EXTENSION_STATUS.needsSiteAccess]: {
    toolOffered: false,
    promptLine:
      "BROWSER: Tell the user, in their language, to grant website access in the stella extension popup. Do not claim you have no way to use a browser.",
  },
  [BROWSER_EXTENSION_STATUS.notInstalled]: {
    toolOffered: false,
    promptLine:
      "BROWSER: Tell the user, in their language, to install the stella extension from the chip in the chat composer. Do not claim you have no way to use a browser.",
  },
  [BROWSER_EXTENSION_STATUS.notPaired]: {
    toolOffered: false,
    promptLine:
      "BROWSER: Tell the user, in their language, to open the extension popup on this stella tab and press Connect current stella tab. Do not claim you have no way to use a browser.",
  },
  [BROWSER_EXTENSION_STATUS.unsupportedBrowser]: {
    toolOffered: false,
    promptLine:
      "BROWSER: Tell the user, in their language, that browser control requires a browser that supports the stella Chrome extension. Do not claim you have no way to use a browser.",
  },
} satisfies Record<BrowserExtensionStatus, BrowserExtensionPolicy>;

export const browserExtensionPolicy = (
  extension: BrowserExtensionCapability,
): BrowserExtensionPolicy => BROWSER_EXTENSION_CAPABILITY[extension.status];
