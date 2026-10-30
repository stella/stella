import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result } from "better-result";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliCommandError } from "../cli-exit-code.js";
import type { Context } from "../context.js";
import { CLI_VERSION } from "../generated/cli-version.js";
import {
  channelForPath,
  detectInstallChannel,
  type InstallChannel,
} from "../install-channel.js";
import { EXIT_CODES } from "../mcp-constants.js";
import { buildServerFlag } from "../output-flags.js";

type PathInstallation = {
  path: string;
  target: string;
  channel: InstallChannel | "unknown";
};
type InspectPathOptions = {
  pathValue: string;
  nativePath: string;
  platform?: NodeJS.Platform;
};

type ResolveDoctorNativePathOptions = {
  configDir: string;
  defaultPath: string;
  activeNativePath?: string;
};

export const resolveDoctorNativePath = async ({
  configDir,
  defaultPath,
  activeNativePath,
}: ResolveDoctorNativePathOptions): Promise<string> => {
  const stored = await Result.tryPromise({
    try: () => readFile(path.join(configDir, "install-path"), "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isError(stored)) {
    if (
      typeof stored.error === "object" &&
      stored.error !== null &&
      "code" in stored.error &&
      stored.error.code === "ENOENT"
    ) {
      return activeNativePath ?? defaultPath;
    }
    throw stored.error;
  }
  const nativePath = stored.value.replace(/\r?\n$/u, "");
  if (!path.isAbsolute(nativePath)) {
    throw new CliCommandError(
      "The recorded native installation path must be absolute.",
      EXIT_CODES.validation,
    );
  }
  return nativePath;
};

export const inspectPathInstallations = async ({
  pathValue,
  nativePath,
  platform = process.platform,
}: InspectPathOptions): Promise<PathInstallation[]> => {
  const native = await Result.tryPromise({
    try: () => realpath(nativePath),
    catch: (cause) => cause,
  });
  if (
    Result.isError(native) &&
    !(
      typeof native.error === "object" &&
      native.error !== null &&
      "code" in native.error &&
      native.error.code === "ENOENT"
    )
  ) {
    throw native.error;
  }
  const nativeTarget = Result.isOk(native) ? native.value : undefined;
  const names =
    platform === "win32" ? ["stella.exe", "stella.cmd", "stella"] : ["stella"];
  const candidates = [
    ...new Set(
      pathValue
        .split(platform === "win32" ? ";" : ":")
        .flatMap((directory) =>
          names.map((name) => path.resolve(directory || ".", name)),
        ),
    ),
  ];
  const inspections = await Promise.all(
    candidates.map(async (candidate) => {
      const inspected = await Result.tryPromise({
        try: async () => {
          await access(
            candidate,
            platform === "win32" ? constants.F_OK : constants.X_OK,
          );
          const info = await stat(candidate);
          if (!info.isFile()) {
            return undefined;
          }
          return realpath(candidate);
        },
        catch: (cause) => cause,
      });
      if (Result.isError(inspected)) {
        if (
          typeof inspected.error === "object" &&
          inspected.error !== null &&
          "code" in inspected.error &&
          (inspected.error.code === "ENOENT" ||
            inspected.error.code === "ENOTDIR" ||
            inspected.error.code === "EACCES")
        ) {
          return undefined;
        }
        throw inspected.error;
      }
      if (inspected.value === undefined) {
        return undefined;
      }
      const channel =
        inspected.value === nativeTarget
          ? "native"
          : (channelForPath(inspected.value) ?? "unknown");
      return { path: candidate, target: inspected.value, channel };
    }),
  );
  return inspections.filter(
    (entry): entry is PathInstallation => entry !== undefined,
  );
};

export const doctorLines = ({
  installations,
  channel,
  version,
}: {
  installations: readonly PathInstallation[];
  channel: InstallChannel;
  version: string;
}): string[] => {
  const lines = [
    `Install channel: ${channel}`,
    `Version: ${version}`,
    "stella on PATH (in order):",
    ...installations.map((entry) => `  ${entry.path} (${entry.channel})`),
  ];
  const native = installations.findIndex((entry) => entry.channel === "native");
  const npm = installations.findIndex((entry) => entry.channel === "npm");
  if (native !== -1 && npm !== -1) {
    lines.push(
      `Warning: ${native < npm ? "native" : "npm"} stella shadows the ${native < npm ? "npm" : "native"} copy.`,
      "Keep the native installation: npm uninstall -g @stll/cli",
      "Then open a new shell and run: stella doctor",
    );
  }
  return lines;
};

export const doctorCommand: Command<Context> = buildCommand<
  { fix: boolean | undefined; server: string | undefined },
  [],
  Context
>({
  docs: { brief: "Inspect installation channel and PATH shadowing" },
  parameters: {
    flags: {
      ...buildServerFlag(),
      fix: {
        kind: "boolean",
        optional: true,
        brief: "Disable a shadowing npm symlink (restorable)",
      },
    },
  },
  func: async function func(this: Context, flags) {
    const inspected = await Result.tryPromise(async () => {
      const channel = await detectInstallChannel({ configDir: this.configDir });
      const nativePath = await resolveDoctorNativePath({
        configDir: this.configDir,
        defaultPath: path.join(
          os.homedir(),
          ".local",
          "bin",
          this.process.platform === "win32" ? "stella.exe" : "stella",
        ),
        ...(channel === "native"
          ? { activeNativePath: this.process.execPath }
          : {}),
      });
      const installations = await inspectPathInstallations({
        pathValue: this.process.env["PATH"] ?? "",
        nativePath,
        platform: this.process.platform,
      });
      const lines = doctorLines({
        installations,
        channel,
        version: CLI_VERSION,
      });
      if (flags.fix) {
        const nativeIndex = installations.findIndex(
          (entry) => entry.channel === "native",
        );
        const first = installations.at(0);
        if (
          nativeIndex > 0 &&
          first?.channel === "npm" &&
          (await lstat(first.path)).isSymbolicLink()
        ) {
          const backup = `${first.path}.stella-disabled`;
          const exists = await Result.tryPromise({
            try: () => access(backup),
            catch: (cause) => cause,
          });
          if (Result.isOk(exists)) {
            return new CliCommandError(
              `Backup already exists: ${backup}; no change made.`,
              EXIT_CODES.validation,
            );
          }
          if (!(
            typeof exists.error === "object" &&
            exists.error !== null &&
            "code" in exists.error &&
            exists.error.code === "ENOENT"
          )) {
            throw exists.error;
          }
          await rename(first.path, backup);
          lines.push(
            `Disabled ${first.path}. Undo: mv '${backup.replaceAll("'", "'\\''")}' '${first.path.replaceAll("'", "'\\''")}'`,
          );
        } else {
          lines.push(
            "No reversible PATH fix is available; use the migration command above.",
          );
        }
      }
      this.process.stdout.write(`${lines.join("\n")}\n`);
      return undefined;
    });
    return Result.isError(inspected)
      ? new CliCommandError(
          "Could not inspect stella installations on PATH.",
          EXIT_CODES.validation,
        )
      : inspected.value;
  },
});
