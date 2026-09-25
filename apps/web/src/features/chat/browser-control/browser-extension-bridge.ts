import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserClientCapability,
  type BrowserControlResult,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserExtensionRequest,
  type BrowserObservedTab,
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import { resetBrowserApproval } from "./browser-approval-mode";
import type { BrowserCommandRun } from "./browser-tool-execution";

const RESPONSE_TIMEOUT_MS = 45_000;

type PendingRequest = {
  command: BrowserControlCommand;
  /** Ends the wait when chat stops the command. */
  detach: () => void;
  resolve: (result: BrowserControlResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Which controller and controlled tab the extension last reported. */
type ExtensionIdentity = {
  controlledTabId: number | null;
  controllerId: string | null;
};

type BrowserExtensionBridgeRuntime = {
  allSitesGranted: boolean;
  controllerId: string | null;
  /** Unset until the extension first reports; the first report changes nothing. */
  identity: ExtensionIdentity | null;
  mountCount: number;
  /** The tab and snapshot of the last successful result; sent with every command. */
  observedTab: BrowserObservedTab | null;
  pendingRequests: Map<string, PendingRequest>;
};

let bridgeRuntime: BrowserExtensionBridgeRuntime | null = null;

const getBridgeRuntime = (): BrowserExtensionBridgeRuntime => {
  bridgeRuntime ??= {
    allSitesGranted: false,
    controllerId: null,
    identity: null,
    mountCount: 0,
    observedTab: null,
    pendingRequests: new Map(),
  };
  return bridgeRuntime;
};

const errorResult = (
  code: BrowserControlErrorCode,
  message: string,
): BrowserControlResult => ({
  code,
  message: message.slice(0, BROWSER_CONTROL_LIMITS.errorMessageChars),
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
});

/**
 * The extension stopped answering after the command was posted. A read has
 * no effect to lose, but an action may already have run, so the model is told
 * to look before it retries.
 */
const unansweredResult = (
  command: BrowserControlCommand,
  readOnly: { code: BrowserControlErrorCode; message: string },
): BrowserControlResult =>
  isReadOnlyBrowserCommand(command)
    ? errorResult(readOnly.code, readOnly.message)
    : errorResult(
        BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
        `${readOnly.message} The action may have taken effect; take a snapshot before retrying it.`,
      );

const postRequest = (request: BrowserExtensionRequest): void => {
  window.postMessage(request, window.location.origin);
};

const ping = (): void => {
  postRequest({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
    type: "ping",
  });
};

/**
 * A new pairing, a disconnect, or a tab the user handed over from the
 * extension popup: what was approved for the previous one no longer holds.
 */
const observeIdentity = (
  runtime: BrowserExtensionBridgeRuntime,
  next: ExtensionIdentity,
): void => {
  const previous = runtime.identity;
  runtime.identity = next;
  if (
    previous === null ||
    (previous.controllerId === next.controllerId &&
      previous.controlledTabId === next.controlledTabId)
  ) {
    return;
  }
  if (previous.controllerId !== next.controllerId) {
    runtime.observedTab = null;
  }
  resetBrowserApproval();
};

const handleMessage = ({ data, origin, source }: MessageEvent): void => {
  if (source !== window || origin !== window.location.origin) {
    return;
  }

  const response = parseBrowserExtensionResponse(data);
  if (!response) {
    return;
  }

  const runtime = getBridgeRuntime();
  if (response.type === "pong") {
    runtime.allSitesGranted = response.allSitesGranted;
    runtime.controllerId = response.controllerId;
    // The content script announces itself before it knows the pairing.
    if (response.requestId === "extension-ready") {
      ping();
      return;
    }
    observeIdentity(runtime, {
      controlledTabId: response.controlledTabId,
      controllerId: response.controllerId,
    });
    return;
  }

  const pending = runtime.pendingRequests.get(response.requestId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  pending.detach();
  runtime.pendingRequests.delete(response.requestId);
  if (response.result.status === "success") {
    const { revision, tabId } = response.result.snapshot;
    runtime.observedTab = { revision, tabId };
    runtime.identity = {
      controlledTabId: tabId,
      controllerId: runtime.identity?.controllerId ?? runtime.controllerId,
    };
  }
  pending.resolve(response.result);
};

const handleWindowFocus = (): void => {
  ping();
};

export const mountBrowserExtensionBridge = (): (() => void) => {
  const runtime = getBridgeRuntime();
  runtime.mountCount += 1;
  if (runtime.mountCount === 1) {
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("message", handleMessage);
    ping();
  }

  return () => {
    runtime.mountCount -= 1;
    if (runtime.mountCount !== 0) {
      return;
    }
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("message", handleMessage);
    runtime.allSitesGranted = false;
    runtime.controllerId = null;
    for (const pending of runtime.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.detach();
      pending.resolve(
        unansweredResult(pending.command, {
          code: BROWSER_CONTROL_ERROR_CODE.disconnected,
          message: "The stella browser extension disconnected.",
        }),
      );
    }
    runtime.pendingRequests.clear();
    bridgeRuntime = null;
  };
};

export const getBrowserClientCapability = ():
  | BrowserClientCapability
  | undefined =>
  bridgeRuntime?.allSitesGranted && bridgeRuntime.controllerId
    ? { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }
    : undefined;

/** Stops the controller's queued or running command of `turnId` in the extension. */
const postCancel = (controllerId: string, turnId: string): void => {
  postRequest({
    controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
    turnId,
    type: "cancel",
  });
};

export const executeBrowserExtensionCommand = async (
  rawCommand: unknown,
  toolCallId: string,
  { signal, turnId }: BrowserCommandRun,
): Promise<BrowserControlResult> => {
  const runtime = getBridgeRuntime();
  const command = parseBrowserControlCommand(rawCommand);
  if (!command) {
    return errorResult(
      BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      "The browser command does not match the tool's input schema.",
    );
  }
  const controllerId = runtime.controllerId;
  if (!runtime.allSitesGranted || controllerId === null) {
    return errorResult(
      BROWSER_CONTROL_ERROR_CODE.disconnected,
      "Install the stella browser extension and grant website access before using this tool.",
    );
  }

  if (signal.aborted) {
    return errorResult(
      BROWSER_CONTROL_ERROR_CODE.cancelled,
      "The browser action was stopped before it ran.",
    );
  }

  const requestId = crypto.randomUUID();
  return await new Promise<BrowserControlResult>((resolve) => {
    const onStop = () => {
      clearTimeout(timeout);
      runtime.pendingRequests.delete(requestId);
      postCancel(controllerId, turnId);
      resolve(
        unansweredResult(command, {
          code: BROWSER_CONTROL_ERROR_CODE.cancelled,
          message: "The browser action was stopped from chat.",
        }),
      );
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onStop);
      runtime.pendingRequests.delete(requestId);
      resolve(
        unansweredResult(command, {
          code: BROWSER_CONTROL_ERROR_CODE.timedOut,
          message: "The stella browser extension did not answer in time.",
        }),
      );
    }, RESPONSE_TIMEOUT_MS);
    signal.addEventListener("abort", onStop, { once: true });
    runtime.pendingRequests.set(requestId, {
      command,
      detach: () => signal.removeEventListener("abort", onStop),
      resolve,
      timeout,
    });
    postRequest({
      command,
      controllerId,
      observedTab: runtime.observedTab,
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
      toolCallId,
      turnId,
      type: "command",
    });
  });
};
