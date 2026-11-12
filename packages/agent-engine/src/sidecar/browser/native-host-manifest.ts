import { Result } from "better-result";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STELLA_DESKTOP_NATIVE_HOST } from "@stll/api-contract/browser-control";

/**
 * Registers the native messaging host with Chrome for the current user, so
 * the stella extension can start it. macOS only for now: Chrome reads
 * per-user hosts from `NativeMessagingHosts` in its profile root. A Chrome
 * that was never installed gets nothing written.
 *
 * Chrome starts the manifest's `path` with only the caller's origin as an
 * argument, so the path is a small script beside the holder's files that
 * starts this sidecar as the host, with the bridge's socket and secret file.
 * Each holder writes its own, so the newest desktop release's host is the
 * one Chrome starts.
 */

/** The script Chrome starts, in the holder's private folder. */
const NATIVE_HOST_SCRIPT = "browser-host";

/**
 * Where Chrome keeps a user's profiles, under the home folder; it reads
 * per-user hosts from `NativeMessagingHosts` there. `null` where stella
 * does not register a host yet (Windows registers through the registry).
 */
const chromeProfileRoot = (platform: NodeJS.Platform): string[] | null => {
  switch (platform) {
    case "darwin":
      return ["Library", "Application Support", "Google", "Chrome"];
    case "linux":
      return [".config", "google-chrome"];
    default:
      return null;
  }
};

/** One argument for `/bin/sh`, whatever it contains. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type InstallNativeHostOptions = {
  platform: NodeJS.Platform;
  home: string;
  /** The holder's private folder. */
  dir: string;
  /** How to start this sidecar: its executable, and the script in development. */
  command: readonly string[];
  endpoint: string;
  secretFile: string;
  /** The extension ids allowed to start the host. */
  extensionIds: readonly string[];
};

type InstallNativeHostOutcome =
  | { type: "installed"; manifest: string }
  | { type: "skipped"; reason: "unsupported_platform" | "no_chrome" };

export const installNativeHost = ({
  command,
  dir,
  endpoint,
  extensionIds,
  home,
  platform,
  secretFile,
}: InstallNativeHostOptions): Result<
  InstallNativeHostOutcome,
  { message: string }
> => {
  const profileFolders = chromeProfileRoot(platform);
  if (profileFolders === null) {
    return Result.ok({ reason: "unsupported_platform", type: "skipped" });
  }
  const profileRoot = path.join(home, ...profileFolders);
  if (!existsSync(profileRoot)) {
    return Result.ok({ reason: "no_chrome", type: "skipped" });
  }
  return Result.try({
    try: () => {
      const script = path.join(dir, NATIVE_HOST_SCRIPT);
      const invocation = [
        ...command,
        "--native-host",
        "--browser-endpoint",
        endpoint,
        "--browser-secret-file",
        secretFile,
      ]
        .map(shellQuote)
        .join(" ");
      const scriptText = `#!/bin/sh\nexec ${invocation} "$@"\n`;
      writeFileSync(`${script}.tmp`, scriptText, { mode: 0o700 });
      renameSync(`${script}.tmp`, script);

      const hostsDir = path.join(profileRoot, "NativeMessagingHosts");
      mkdirSync(hostsDir, { recursive: true });
      const manifest = path.join(
        hostsDir,
        `${STELLA_DESKTOP_NATIVE_HOST}.json`,
      );
      const manifestText = `${JSON.stringify(
        {
          name: STELLA_DESKTOP_NATIVE_HOST,
          description: "stella desktop",
          path: script,
          type: "stdio",
          allowed_origins: extensionIds.map(
            (id) => `chrome-extension://${id}/`,
          ),
        },
        null,
        2,
      )}\n`;
      writeFileSync(`${manifest}.tmp`, manifestText, { mode: 0o644 });
      renameSync(`${manifest}.tmp`, manifest);
      return { manifest, type: "installed" } as const;
    },
    catch: (error) => ({
      message: error instanceof Error ? error.message : "write failed",
    }),
  });
};
