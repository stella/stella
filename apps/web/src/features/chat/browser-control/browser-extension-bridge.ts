import { useSyncExternalStore } from "react";

import { TaggedError } from "better-result";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  BROWSER_EXTENSION_STATUS,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  type BrowserExtensionCapability,
  type BrowserExtensionRequest,
  type BrowserExtensionStatus,
  type BrowserObservedTab,
  isReadOnlyBrowserCommand,
  parseBrowserControlCommand,
  parseBrowserExtensionPeerVersion,
  parseBrowserExtensionResponse,
} from "@stll/api-contract/browser-control";

import { createUuid } from "@/lib/uuid";

import { resetBrowserApproval } from "./browser-approval-mode";
import type { BrowserCommandRun } from "./browser-tool-execution";

const RESPONSE_TIMEOUT_MS = 45_000;
export const BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS = 1000;
const BROWSER_EXTENSION_STATES = {
  checking: {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: BROWSER_EXTENSION_STATUS.checking,
  },
  connected: {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "connected",
  },
  "needs-site-access": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "needs-site-access",
  },
  "not-installed": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "not-installed",
  },
  "not-paired": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "not-paired",
  },
  "extension-outdated": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "extension-outdated",
  },
  "stella-outdated": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "stella-outdated",
  },
  "unsupported-browser": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "unsupported-browser",
  },
  "unsupported-device": {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "unsupported-device",
  },
} satisfies Record<BrowserExtensionStatus, BrowserExtensionCapability>;

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
  announcementDeadline: ReturnType<typeof setTimeout> | null;
  announced: boolean;
  controllerId: string | null;
  /**
   * The protocol version the extension last spoke when it differs from this
   * tab's; null while the two match or nothing has been heard yet.
   */
  extensionProtocolVersion: number | null;
  /** Unset until the extension first reports; the first report changes nothing. */
  identity: ExtensionIdentity | null;
  mountCount: number;
  /** The tab and snapshot of the last successful result; sent with every command. */
  observedTab: BrowserObservedTab | null;
  pendingRequests: Map<string, PendingRequest>;
};

let bridgeRuntime: BrowserExtensionBridgeRuntime | null = null;

/** Fires whenever whether a browser client is connected may have changed. */
const connectionEvents = new EventTarget();
const connectionChangedEvent = new Event("connection-changed");

const notifyConnectionListeners = (): void => {
  connectionEvents.dispatchEvent(connectionChangedEvent);
};

const getBridgeRuntime = (): BrowserExtensionBridgeRuntime => {
  bridgeRuntime ??= {
    allSitesGranted: false,
    announcementDeadline: null,
    announced: false,
    controllerId: null,
    extensionProtocolVersion: null,
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
    requestId: createUuid(),
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

const markAnnounced = (runtime: BrowserExtensionBridgeRuntime): void => {
  runtime.announced = true;
  if (runtime.announcementDeadline !== null) {
    clearTimeout(runtime.announcementDeadline);
    runtime.announcementDeadline = null;
  }
};

const handleMessage = ({ data, origin, source }: MessageEvent): void => {
  if (source !== window || origin !== window.location.origin) {
    return;
  }

  const response = parseBrowserExtensionResponse(data);
  if (!response) {
    // An extension on another protocol version is installed, not missing:
    // which side is older decides whether Chrome's update or a reload helps.
    const peerVersion = parseBrowserExtensionPeerVersion(data);
    if (
      peerVersion !== null &&
      peerVersion !== BROWSER_CONTROL_PROTOCOL_VERSION
    ) {
      const runtime = getBridgeRuntime();
      markAnnounced(runtime);
      runtime.extensionProtocolVersion = peerVersion;
      notifyConnectionListeners();
    }
    return;
  }

  const runtime = getBridgeRuntime();
  if (response.type === "pong") {
    markAnnounced(runtime);
    runtime.extensionProtocolVersion = null;
    runtime.allSitesGranted = response.allSitesGranted;
    runtime.controllerId = response.controllerId;
    notifyConnectionListeners();
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
    runtime.announcementDeadline = setTimeout(() => {
      runtime.announcementDeadline = null;
      notifyConnectionListeners();
    }, BROWSER_EXTENSION_ANNOUNCEMENT_DEADLINE_MS);
  }

  return () => {
    runtime.mountCount -= 1;
    if (runtime.mountCount !== 0) {
      return;
    }
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("message", handleMessage);
    if (runtime.announcementDeadline !== null) {
      clearTimeout(runtime.announcementDeadline);
    }
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
    notifyConnectionListeners();
  };
};

/** Telemetry only: a send started while no bridge was mounted. */
export class BrowserBridgeUnmountedError extends TaggedError(
  "BrowserBridgeUnmountedError",
)<{ message: string }> {}

/**
 * The bridge is mounted once by `AppFrameHost`, above every frame, so every chat send
 * sees the extension's pairing. A send while it is unmounted drops the browser
 * tool silently, which the send path reports.
 */
export const isBrowserExtensionBridgeMounted = (): boolean =>
  bridgeRuntime !== null && bridgeRuntime.mountCount > 0;

type BrowserExtensionNavigator = {
  maxTouchPoints?: number;
  userAgent: string;
  userAgentData?: { brands: readonly { brand: string }[]; mobile?: boolean };
};

/**
 * An iPad browser asks for desktop sites by default and then names itself a
 * Mac; only its touch screen gives it away, since a Mac reports no touch
 * points.
 */
const isIpadAsMac = (browser: BrowserExtensionNavigator): boolean =>
  /Macintosh/u.test(browser.userAgent) && (browser.maxTouchPoints ?? 0) > 1;

type BrowserExtensionSupport =
  | "supported"
  | typeof BROWSER_EXTENSION_STATUS.unsupportedBrowser
  | typeof BROWSER_EXTENSION_STATUS.unsupportedDevice;

/**
 * Whether this browser can run the Chrome extension. A computer with another
 * browser can still switch to Chrome; a phone or tablet cannot run it at all,
 * so the chat tells the two apart.
 */
export const browserExtensionSupport = (
  browser: BrowserExtensionNavigator | undefined,
): BrowserExtensionSupport => {
  if (
    !browser ||
    /Android|FxiOS|CriOS|iPhone|iPad|iPod/u.test(browser.userAgent) ||
    isIpadAsMac(browser) ||
    browser.userAgentData?.mobile === true
  ) {
    return BROWSER_EXTENSION_STATUS.unsupportedDevice;
  }
  if (/Firefox/u.test(browser.userAgent)) {
    return BROWSER_EXTENSION_STATUS.unsupportedBrowser;
  }
  const chromium = browser.userAgentData
    ? browser.userAgentData.brands.some(
        ({ brand }) => brand === "Chromium" || brand === "Google Chrome",
      )
    : /Chrome|Chromium/u.test(browser.userAgent);
  return chromium ? "supported" : BROWSER_EXTENSION_STATUS.unsupportedBrowser;
};

/**
 * The single live state of the extension for this stella tab. Unsupported means
 * the browser (or the whole device) cannot run the Chrome extension; checking
 * lasts until the first announcement or deadline; not-installed follows one
 * missed announcement deadline; an extension on another protocol version is
 * outdated on whichever side is older; access and pairing are reported by the
 * extension; connected means stella can execute commands from this tab.
 */
export const getBrowserExtensionState = (): BrowserExtensionCapability => {
  const runtime = bridgeRuntime;
  const support = browserExtensionSupport(
    typeof navigator === "undefined" ? undefined : navigator,
  );
  if (support !== "supported") {
    return BROWSER_EXTENSION_STATES[support];
  }
  if (
    runtime === null ||
    (!runtime.announced && runtime.announcementDeadline === null)
  ) {
    return BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.notInstalled];
  }
  if (!runtime.announced) {
    return BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.checking];
  }
  if (runtime.extensionProtocolVersion !== null) {
    return BROWSER_EXTENSION_STATES[
      runtime.extensionProtocolVersion < BROWSER_CONTROL_PROTOCOL_VERSION
        ? BROWSER_EXTENSION_STATUS.extensionOutdated
        : BROWSER_EXTENSION_STATUS.stellaOutdated
    ];
  }
  if (!runtime.allSitesGranted) {
    return BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.needsSiteAccess];
  }
  if (runtime.controllerId === null) {
    return BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.notPaired];
  }
  return BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.connected];
};

const subscribeBrowserExtensionConnection = (listener: () => void) => {
  connectionEvents.addEventListener(connectionChangedEvent.type, listener);
  return () => {
    connectionEvents.removeEventListener(connectionChangedEvent.type, listener);
  };
};

export const useBrowserExtensionState = (): BrowserExtensionCapability =>
  useSyncExternalStore(
    subscribeBrowserExtensionConnection,
    getBrowserExtensionState,
    () => BROWSER_EXTENSION_STATES[BROWSER_EXTENSION_STATUS.unsupportedBrowser],
  );

/** Stops the controller's queued or running command of `turnId` in the extension. */
const postCancel = (controllerId: string, turnId: string): void => {
  postRequest({
    controllerId,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    requestId: createUuid(),
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

  const requestId = createUuid();
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
