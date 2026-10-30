import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliCommandError } from "../cli-exit-code.js";
import type { Context } from "../context.js";
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

type UpdateNativeOptions = {
  channel: InstallChannel;
  executablePath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string | undefined;
  fetcher?: UpdateFetch;
};

export const updateNative = async ({
  channel,
  executablePath,
  platform = process.platform,
  arch = process.arch,
  version,
  fetcher = fetch,
}: UpdateNativeOptions): Promise<Result<string, NativeUpdateError>> => {
  if (channel !== "native") {
    return Result.err(
      new NativeUpdateError({
        message: `This installation is managed by ${channel}; run ${upgradeCommandFor(channel)}.`,
      }),
    );
  }
  if (version !== undefined && !/^\d+\.\d+\.\d+$/u.test(version)) {
    return Result.err(
      new NativeUpdateError({
        message: "STELLA_VERSION must be a stable version (for example 6.2.0).",
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
  const release =
    version === undefined
      ? `${RELEASE_BASE_URL}/latest/download`
      : `${RELEASE_BASE_URL}/download/v${version}`;
  const download = await Result.tryPromise({
    try: async () => {
      const downloadAsset = async (name: string): Promise<Response> => {
        let url = `${release}/${name}`;
        // Release assets redirect to GitHub's asset CDN. Validate before each request.
        for (let redirects = 0; redirects < 5; redirects += 1) {
          const parsed = new URL(url);
          if (
            parsed.protocol !== "https:" ||
            !(
              parsed.hostname === "github.com" ||
              parsed.hostname.endsWith(".githubusercontent.com")
            )
          ) {
            return new Response(null, { status: 400 });
          }
          const response = await fetcher(url, {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            redirect: "manual",
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) {
            return response;
          }
          const location = response.headers.get("location");
          if (location === null) {
            return new Response(null, { status: 400 });
          }
          url = new URL(location, url).href;
        }
        return new Response(null, { status: 400 });
      };
      const responses = await Promise.all(
        [asset, "checksums.txt"].map(downloadAsset),
      );
      const binary = responses.at(0);
      const sums = responses.at(1);
      if (
        binary === undefined ||
        sums === undefined ||
        !binary.ok ||
        !sums.ok
      ) {
        return Result.err(
          new NativeUpdateError({
            message: "Could not download the CLI release and checksums.",
          }),
        );
      }
      for (const response of responses) {
        if (
          response.url !== "" &&
          new URL(response.url).protocol !== "https:"
        ) {
          return Result.err(
            new NativeUpdateError({
              message: "CLI release downloads require HTTPS.",
            }),
          );
        }
      }
      const bytes = new Uint8Array(await binary.arrayBuffer());
      const expected = (await sums.text())
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
        return Result.ok(
          `Updated stella${version === undefined ? "" : ` to ${version}`}.`,
        );
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
  { server: string | undefined },
  [],
  Context
>({
  docs: { brief: "Update a standalone stella installation" },
  parameters: { flags: buildServerFlag() },
  func: async function func(this: Context) {
    const result = await updateNative({
      channel: await detectInstallChannel({ configDir: this.configDir }),
      executablePath: this.process.execPath,
      version: this.process.env["STELLA_VERSION"],
    });
    if (Result.isError(result)) {
      return new CliCommandError(result.error.message, EXIT_CODES.validation);
    }
    this.process.stdout.write(`${result.value}\n`);
    return undefined;
  },
});
