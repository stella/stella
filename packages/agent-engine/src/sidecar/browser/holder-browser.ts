import { Result } from "better-result";
import path from "node:path";

import { BROWSER_EXTENSION_ID } from "@stll/api-contract/browser-control";
import { sha256Hex } from "@stll/sha256/node";

import type { StellaBrowserTestHooks } from "../env";
import { type BrowserBridge, startBrowserBridge } from "./bridge";
import { createHostRouter, extensionHost } from "./host-router";
import { type LocalBrowserMcp, startLocalBrowserMcp } from "./mcp-server";
import { installNativeHost } from "./native-host-manifest";
import { createStellaBrowserHost } from "./stella-browser/host";

/**
 * The holder's browser: the bridge Chrome's host connects to, the host's
 * registration with Chrome, and the MCP server the runs' harnesses call.
 * With the development switch on, the stella browser too, and then the MCP
 * server starts without the extension's host. Unix only for now (named
 * pipes on Windows come later); a holder without it runs harnesses without
 * browser tools.
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

/** The stella browser, when the development switch is on. */
export type StellaBrowserOptions = {
  /** Where its profiles live: `<app data>/browser`. */
  profileRoot: string;
  /** The environment the holder started with; the browser gets a minimal part. */
  environment: Readonly<Record<string, string | undefined>>;
  testHooks: StellaBrowserTestHooks | null;
};

export type HolderBrowserOptions = {
  /** How to start this sidecar: its executable, and the script in development. */
  command: readonly string[];
  /**
   * The member's home folder. Without one no host is registered with
   * Chrome, and runs get no browser tools unless the stella browser is on.
   */
  home: string | null;
  /** Where Chrome looks for the host depends on it. */
  platform: NodeJS.Platform;
  /** Development extension ids allowed besides the store's. */
  extraExtensionIds: readonly string[];
  /** `null` while the development switch is off. */
  stellaBrowser: StellaBrowserOptions | null;
};

type HolderBrowserOutcome =
  | {
      type: "started";
      browser: { mcp: LocalBrowserMcp; stop: () => Promise<void> };
    }
  /** Runs go without browser tools; `reason` is for the holder's log. */
  | { type: "unavailable"; reason: string };

type ExtensionBridgeOptions = Omit<HolderBrowserOptions, "stellaBrowser"> & {
  dir: string;
  endpoint: string;
  log: (line: string) => void;
};

/** The extension's bridge, with its host registered with Chrome. */
const startExtensionBridge = async ({
  command,
  dir,
  endpoint,
  extraExtensionIds,
  home,
  log,
  platform,
}: ExtensionBridgeOptions): Promise<
  Result<{ bridge: BrowserBridge; home: string }, string>
> => {
  // Without a host Chrome can start, the extension cannot reach the tools.
  if (home === null) {
    return Result.err("no home folder to register a host in");
  }
  const browserEndpoint = browserEndpointFor(endpoint);
  if (Buffer.byteLength(browserEndpoint) > SUN_PATH_BYTES - 1) {
    return Result.err("its socket path does not fit");
  }
  const bridge = await startBrowserBridge({
    dir,
    endpoint: browserEndpoint,
    log,
    timeoutMs: BROWSER_COMMAND_TIMEOUT_MS,
  });
  if (Result.isError(bridge)) {
    return Result.err(bridge.error.message);
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
    return Result.err(
      `the browser host was not registered: ${installed.error.message}`,
    );
  }
  if (installed.value.type === "skipped") {
    await bridge.value.stop();
    return Result.err(
      `the browser host was not registered: ${installed.value.reason}`,
    );
  }
  log("the browser host is registered with Chrome");
  return Result.ok({ bridge: bridge.value, home });
};

export const startHolderBrowser = async ({
  accountOrigin,
  stellaBrowser,
  ...options
}: HolderBrowserOptions & {
  /** The connected desktop's API origin; the stella browser's profile is the account's. */
  accountOrigin: () => string | null;
  dir: string;
  /** The holder's own endpoint. */
  endpoint: string;
  log: (line: string) => void;
  version: string;
}): Promise<HolderBrowserOutcome> => {
  const { home, log, platform, version } = options;
  if (platform === "win32") {
    return { reason: "not on Windows yet", type: "unavailable" };
  }
  const extension = await startExtensionBridge(options);
  if (Result.isError(extension)) {
    if (stellaBrowser === null) {
      return { reason: extension.error, type: "unavailable" };
    }
    log(`no extension bridge: ${extension.error}`);
  }
  const bridge = Result.isOk(extension) ? extension.value.bridge : null;
  const stella =
    stellaBrowser === null
      ? null
      : createStellaBrowserHost({
          accountOrigin,
          environment: stellaBrowser.environment,
          home,
          log,
          platform,
          profileRoot: stellaBrowser.profileRoot,
          testHooks: stellaBrowser.testHooks,
        });
  const stopHosts = async () => {
    await stella?.stop();
    await bridge?.stop();
  };
  // The loopback listener can fail to start; the holder goes on without
  // browser tools then.
  const started = Result.try(() =>
    startLocalBrowserMcp({
      browser: createHostRouter({
        extension: bridge === null ? null : extensionHost(bridge),
        stellaBrowser: stella,
      }),
      downloads: Result.isOk(extension)
        ? {
            home: extension.value.home,
            onDownload: extension.value.bridge.onDownload,
          }
        : null,
      version,
    }),
  );
  if (Result.isError(started)) {
    await stopHosts();
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
        await stopHosts();
      },
    },
    type: "started",
  };
};
