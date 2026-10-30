import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliCommandError } from "../cli-exit-code.js";
import type { Context } from "../context.js";
import { CLI_VERSION } from "../generated/cli-version.js";
import {
  detectInstallChannel,
  type InstallChannel,
  upgradeCommandFor,
} from "../install-channel.js";
import { EXIT_CODES } from "../mcp-constants.js";
import { buildServerFlag } from "../output-flags.js";
import { sha256Hex } from "../sha256.js";

const RELEASE_BASE_URL = "https://github.com/stella/stella/releases";
const DOWNLOAD_TIMEOUT_MS = 120_000;
const NativeUpdateErrorBase: TaggedErrorClass<"NativeUpdateError"> =
  TaggedError("NativeUpdateError");
export class NativeUpdateError extends NativeUpdateErrorBase<{
  message: string;
  cause?: unknown;
}> {}

export type UpdateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type StableVersion = { major: number; minor: number; patch: number };

const parseStableVersion = (version: string): StableVersion | undefined => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) {
    return undefined;
  }
  const parsed = {
    major: Number(match.at(1)),
    minor: Number(match.at(2)),
    patch: Number(match.at(3)),
  };
  return Object.values(parsed).every(Number.isSafeInteger) ? parsed : undefined;
};

type DownloadAssetOptions = {
  name: string;
  fetcher: UpdateFetch;
  version?: string;
};

const downloadAsset = async ({
  name,
  fetcher,
  version,
}: DownloadAssetOptions): Promise<
  Result<{ response: Response; version: string }, NativeUpdateError>
> => {
  let url = `${RELEASE_BASE_URL}/${version === undefined ? "latest/download" : `download/v${version}`}/${name}`;
  let resolvedVersion = version;
  // The pinned GitHub release redirect binds the binary and checksum to one version.
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "github.com" ||
        parsed.hostname.endsWith(".githubusercontent.com")
      )
    ) {
      return Result.err(
        new NativeUpdateError({
          message: "CLI release downloads require a verified HTTPS GitHub URL.",
        }),
      );
    }
    if (
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith("/stella/stella/releases/download/")
    ) {
      const match =
        /^\/stella\/stella\/releases\/download\/v([^/]+)\/([^/]+)$/u.exec(
          parsed.pathname,
        );
      const advertisedVersion = match?.at(1);
      if (
        advertisedVersion === undefined ||
        parseStableVersion(advertisedVersion) === undefined ||
        match?.at(2) !== name
      ) {
        return Result.err(
          new NativeUpdateError({
            message:
              "CLI release redirect has a missing or malformed stable version.",
          }),
        );
      }
      if (
        resolvedVersion !== undefined &&
        resolvedVersion !== advertisedVersion
      ) {
        return Result.err(
          new NativeUpdateError({
            message: "CLI release redirects disagree on the target version.",
          }),
        );
      }
      resolvedVersion = advertisedVersion;
    }
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) {
        return Result.err(
          new NativeUpdateError({
            message: "Could not download the CLI release and checksums.",
          }),
        );
      }
      if (resolvedVersion === undefined) {
        return Result.err(
          new NativeUpdateError({
            message:
              "CLI release redirect did not identify a stable target version.",
          }),
        );
      }
      return Result.ok({ response, version: resolvedVersion });
    }
    const location = response.headers.get("location");
    if (location === null) {
      return Result.err(
        new NativeUpdateError({
          message: "CLI release redirect has no location.",
        }),
      );
    }
    url = new URL(location, url).href;
  }
  return Result.err(
    new NativeUpdateError({ message: "Too many CLI release redirects." }),
  );
};

type UpdateNativeOptions = {
  channel: InstallChannel;
  executablePath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  allowDowngrade?: boolean;
  beforeReplace?: (change: {
    from: string;
    to: string;
    direction: "upgrade" | "downgrade";
  }) => void;
  fetcher?: UpdateFetch;
};

export const updateNative = async ({
  channel,
  executablePath,
  platform = process.platform,
  arch = process.arch,
  allowDowngrade = false,
  beforeReplace,
  fetcher = fetch,
}: UpdateNativeOptions): Promise<Result<string, NativeUpdateError>> => {
  if (channel !== "native") {
    return Result.err(
      new NativeUpdateError({
        message: `This installation is managed by ${channel}; run ${upgradeCommandFor(channel)}.`,
      }),
    );
  }
  const os = platform === "win32" ? "windows" : platform;
  if (
    !(
      (os === "darwin" || os === "linux") &&
      (arch === "arm64" || arch === "x64")
    ) &&
    !(os === "windows" && arch === "x64")
  ) {
    return Result.err(
      new NativeUpdateError({
        message: `Unsupported platform: ${os}-${arch}.`,
      }),
    );
  }
  const asset = `stella-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  const download = await Result.tryPromise({
    try: async () => {
      const binary = await downloadAsset({ name: asset, fetcher });
      if (Result.isError(binary)) {
        return binary;
      }
      const version = binary.value.version;
      const current = parseStableVersion(CLI_VERSION);
      const target = parseStableVersion(version);
      if (current === undefined || target === undefined) {
        return Result.err(
          new NativeUpdateError({
            message: "Could not compare stable CLI release versions.",
          }),
        );
      }
      const comparison =
        target.major - current.major ||
        target.minor - current.minor ||
        target.patch - current.patch;
      if (comparison < 0 && !allowDowngrade) {
        return Result.err(
          new NativeUpdateError({
            message: `Refusing to downgrade stella ${CLI_VERSION} -> ${version}; repeat with --allow-downgrade to opt in.`,
          }),
        );
      }
      if (comparison === 0) {
        return Result.ok(`stella ${CLI_VERSION} is already current.`);
      }
      const sums = await downloadAsset({
        name: "checksums.txt",
        fetcher,
        version,
      });
      if (Result.isError(sums)) {
        return sums;
      }
      const bytes = new Uint8Array(await binary.value.response.arrayBuffer());
      const expected = (await sums.value.response.text())
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u))
        .find((parts) => parts.at(1) === asset)
        ?.at(0);
      if (
        expected === undefined ||
        !/^[a-fA-F0-9]{64}$/u.test(expected) ||
        sha256Hex(bytes) !== expected.toLowerCase()
      ) {
        return Result.err(
          new NativeUpdateError({
            message:
              "CLI checksum verification failed; installation was not changed.",
          }),
        );
      }
      beforeReplace?.({
        from: CLI_VERSION,
        to: version,
        direction: comparison < 0 ? "downgrade" : "upgrade",
      });
      // Stage beside the executable so rename stays on the same filesystem.
      const staging = await mkdtemp(
        path.join(path.dirname(executablePath), ".stella-update-"),
      );
      const replacement = path.join(staging, path.basename(executablePath));
      const replaced = await Result.tryPromise(async () => {
        await writeFile(replacement, bytes, { mode: 0o755 });
        await chmod(replacement, 0o755);
        if (platform === "win32") {
          // Windows permits renaming a running executable, but not overwriting it.
          const previous = path.join(staging, "previous.exe");
          await rename(executablePath, previous);
          const moved = await Result.tryPromise(() =>
            rename(replacement, executablePath),
          );
          if (Result.isError(moved)) {
            await rename(previous, executablePath);
            return Result.err(
              new NativeUpdateError({
                message: "Could not replace the CLI executable.",
                cause: moved.error,
              }),
            );
          }
        } else {
          await rename(replacement, executablePath);
        }
        return Result.ok(`Updated stella ${CLI_VERSION} -> ${version}.`);
      });
      if (platform === "win32" && Result.isError(replaced)) {
        // A failed rollback must retain the previous executable for recovery.
        return Result.err(
          new NativeUpdateError({
            message: `Could not replace stella; recovery files remain at ${staging}.`,
            cause: replaced.error,
          }),
        );
      }
      const cleanup = await Result.tryPromise(() =>
        rm(staging, { recursive: true, force: true }),
      );
      if (Result.isError(cleanup) && platform !== "win32") {
        return Result.err(
          new NativeUpdateError({
            message: `Could not remove staging directory ${staging}.`,
            cause: cleanup.error,
          }),
        );
      }
      if (Result.isError(replaced)) {
        return Result.err(
          new NativeUpdateError({
            message: "Could not replace the CLI executable.",
            cause: replaced.error,
          }),
        );
      }
      if (Result.isError(cleanup)) {
        return Result.ok(
          `Updated stella. Remove ${staging} after exiting stella.`,
        );
      }
      return replaced.value;
    },
    catch: (cause) =>
      new NativeUpdateError({
        message: "Could not complete the stella update.",
        cause,
      }),
  });
  return Result.isError(download) ? download : download.value;
};

export const updateCommand: Command<Context> = buildCommand<
  { server: string | undefined; "allow-downgrade": boolean | undefined },
  [],
  Context
>({
  docs: { brief: "Update a standalone stella installation" },
  parameters: {
    flags: {
      ...buildServerFlag(),
      "allow-downgrade": {
        kind: "boolean",
        optional: true,
        brief: "Explicitly permit replacing this CLI with an older release",
      },
    },
  },
  func: async function func(this: Context, flags) {
    const channel = await detectInstallChannel({ configDir: this.configDir });
    if (Result.isError(channel)) {
      return new CliCommandError(channel.error.message, EXIT_CODES.validation);
    }
    const result = await updateNative({
      channel: channel.value,
      executablePath: this.process.execPath,
      allowDowngrade: flags["allow-downgrade"] === true,
      beforeReplace: ({ from, to, direction }) => {
        this.process.stdout.write(
          `${direction === "downgrade" ? "Warning: downgrading" : "Updating"} stella ${from} -> ${to}.\n`,
        );
      },
    });
    if (Result.isError(result)) {
      return new CliCommandError(result.error.message, EXIT_CODES.validation);
    }
    this.process.stdout.write(`${result.value}\n`);
    return undefined;
  },
});
