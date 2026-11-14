import { Result } from "better-result";
import path from "node:path";

import { BROWSER_EXTENSION_ID } from "@stll/api-contract/browser-control";
import { sha256Hex } from "@stll/sha256/node";

import { startBrowserBridge } from "./bridge";
import { type LocalBrowserMcp, startLocalBrowserMcp } from "./mcp-server";
import { installNativeHost } from "./native-host-manifest";

/**
 * The holder's browser: the bridge Chrome's host connects to, the host's
 * registration with Chrome, and the MCP server the runs' harnesses call.
 * Unix only for now (named pipes on Windows come later); a holder without
 * it runs harnesses without browser tools.
 */

/** `sun_path` bytes on macOS, its NUL included; Linux allows 108. */
const SUN_PATH_BYTES = process.platform === "linux" ? 108 : 104;
/** How long one browser command may take before it is reported unobserved. */
const BROWSER_COMMAND_TIMEOUT_MS = 120_000;

/**
 * The bridge's socket: beside the holder's, named after it but shorter, so
 * it fits wherever the holder's endpoint fits.
 */
export const browserEndpointFor = (holderEndpoint: string): string =>
  path.join(
    path.dirname(holderEndpoint),
    `sb-${sha256Hex(holderEndpoint).slice(0, 8)}.sock`,
  );

export type HolderBrowserOptions = {
  /** How to start this sidecar: its executable, and the script in development. */
  command: readonly string[];
  /**
   * The member's home folder. Without one no host is registered with
   * Chrome, and runs get no browser tools.
   */
  home: string | null;
  /** Where Chrome looks for the host depends on it. */
  platform: NodeJS.Platform;
  /** Development extension ids allowed besides the store's. */
  extraExtensionIds: readonly string[];
};

type HolderBrowserOutcome =
  | {
      type: "started";
      browser: { mcp: LocalBrowserMcp; stop: () => Promise<void> };
    }
  /** Runs go without browser tools; `reason` is for the holder's log. */
  | { type: "unavailable"; reason: string };

export const startHolderBrowser = async ({
  command,
  dir,
  endpoint,
  extraExtensionIds,
  home,
  log,
  platform,
  version,
}: HolderBrowserOptions & {
  dir: string;
  /** The holder's own endpoint. */
  endpoint: string;
  log: (line: string) => void;
  version: string;
}): Promise<HolderBrowserOutcome> => {
  if (platform === "win32") {
    return { reason: "not on Windows yet", type: "unavailable" };
  }
  // Without a host Chrome can start, the tools could only fail: no harness
  // is offered them.
  if (home === null) {
    return {
      reason: "no home folder to register a host in",
      type: "unavailable",
    };
  }
  const browserEndpoint = browserEndpointFor(endpoint);
  if (Buffer.byteLength(browserEndpoint) > SUN_PATH_BYTES - 1) {
    return { reason: "its socket path does not fit", type: "unavailable" };
  }
  const bridge = await startBrowserBridge({
    dir,
    endpoint: browserEndpoint,
    log,
    timeoutMs: BROWSER_COMMAND_TIMEOUT_MS,
  });
  if (Result.isError(bridge)) {
    return { reason: bridge.error.message, type: "unavailable" };
  }
  const installed = installNativeHost({
    command,
    dir,
    endpoint: bridge.value.endpoint,
    extensionIds: [BROWSER_EXTENSION_ID, ...extraExtensionIds],
    home,
    platform,
    secretFile: bridge.value.secretFile,
  });
  if (Result.isError(installed)) {
    await bridge.value.stop();
    return {
      reason: `the browser host was not registered: ${installed.error.message}`,
      type: "unavailable",
    };
  }
  if (installed.value.type === "skipped") {
    await bridge.value.stop();
    return {
      reason: `the browser host was not registered: ${installed.value.reason}`,
      type: "unavailable",
    };
  }
  log("the browser host is registered with Chrome");
  // The loopback listener can fail to start; the holder goes on without
  // browser tools then.
  const started = Result.try(() =>
    startLocalBrowserMcp({ bridge: bridge.value, version }),
  );
  if (Result.isError(started)) {
    await bridge.value.stop();
    return {
      reason: "the browser tools' local endpoint did not start",
      type: "unavailable",
    };
  }
  const mcp = started.value;
  return {
    browser: {
      mcp,
      stop: async () => {
        await mcp.stop();
        await bridge.value.stop();
      },
    },
    type: "started",
  };
};
