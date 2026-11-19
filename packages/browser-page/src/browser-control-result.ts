import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlErrorCode,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";

export const browserControlError = (
  code: BrowserControlErrorCode,
  message: string,
): BrowserControlResult => ({
  code,
  message: message.slice(0, BROWSER_CONTROL_LIMITS.errorMessageChars),
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
});
