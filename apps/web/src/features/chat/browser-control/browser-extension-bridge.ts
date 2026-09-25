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
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

const RESPONSE_TIMEOUT_MS = 45_000;

type PendingRequest = {
  command: BrowserControlCommand;
  resolve: (result: BrowserControlResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type BrowserExtensionBridgeRuntime = {
  allSitesGranted: boolean;
  controllerId: string | null;
  mountCount: number;
  pendingRequests: Map<string, PendingRequest>;
};

let bridgeRuntime: BrowserExtensionBridgeRuntime | null = null;

const getBridgeRuntime = (): BrowserExtensionBridgeRuntime => {
  bridgeRuntime ??= {
    allSitesGranted: false,
    controllerId: null,
    mountCount: 0,
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
    if (response.requestId === "extension-ready") {
      ping();
    }
    return;
  }

  const pending = runtime.pendingRequests.get(response.requestId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timeout);
  runtime.pendingRequests.delete(response.requestId);
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

export const executeBrowserExtensionCommand = async (
  rawCommand: unknown,
  toolCallId: string,
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

  const requestId = crypto.randomUUID();
  return await new Promise<BrowserControlResult>((resolve) => {
    const timeout = setTimeout(() => {
      runtime.pendingRequests.delete(requestId);
      resolve(
        unansweredResult(command, {
          code: BROWSER_CONTROL_ERROR_CODE.timedOut,
          message: "The stella browser extension did not answer in time.",
        }),
      );
    }, RESPONSE_TIMEOUT_MS);
    runtime.pendingRequests.set(requestId, { command, resolve, timeout });
    postRequest({
      command,
      controllerId,
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
      toolCallId,
      type: "command",
    });
  });
};
