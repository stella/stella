import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result, TaggedError, type TaggedErrorClass } from "better-result";
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

const DoctorErrorBase: TaggedErrorClass<"DoctorError"> =
  TaggedError("DoctorError");
export class DoctorError extends DoctorErrorBase<{
  message: string;
  cause?: unknown;
}> {}

const hasFsErrorCode = (cause: unknown, codes: readonly string[]): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string" &&
  codes.includes(cause.code);

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
}: ResolveDoctorNativePathOptions): Promise<Result<string, DoctorError>> => {
  const stored = await Result.tryPromise({
    try: () => readFile(path.join(configDir, "install-path"), "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isError(stored)) {
    if (hasFsErrorCode(stored.error, ["ENOENT"])) {
      return Result.ok(activeNativePath ?? defaultPath);
    }
    return Result.err(
      new DoctorError({
        message: "Could not read the native installation path.",
        cause: stored.error,
      }),
    );
  }
  const nativePath = stored.value.replace(/\r?\n$/u, "");
  if (!path.isAbsolute(nativePath)) {
    return Result.err(
      new DoctorError({
        message: "The recorded native installation path must be absolute.",
      }),
    );
  }
  return Result.ok(nativePath);
};

export const inspectPathInstallations = async ({
  pathValue,
  nativePath,
  platform = process.platform,
}: InspectPathOptions): Promise<Result<PathInstallation[], DoctorError>> => {
  const native = await Result.tryPromise({
    try: () => realpath(nativePath),
    catch: (cause) => cause,
  });
  if (Result.isError(native) && !hasFsErrorCode(native.error, ["ENOENT"])) {
    return Result.err(
      new DoctorError({
        message: "Could not resolve the native executable path.",
        cause: native.error,
      }),
    );
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
        if (hasFsErrorCode(inspected.error, ["ENOENT", "ENOTDIR", "EACCES"])) {
          return Result.ok(undefined);
        }
        return Result.err(
          new DoctorError({
            message: `Could not inspect executable ${candidate}.`,
            cause: inspected.error,
          }),
        );
      }
      if (inspected.value === undefined) {
        return Result.ok(undefined);
      }
      const channel =
        inspected.value === nativeTarget
          ? "native"
          : (channelForPath(inspected.value) ?? "unknown");
      return Result.ok({ path: candidate, target: inspected.value, channel });
    }),
  );
  const installations: PathInstallation[] = [];
  for (const inspected of inspections) {
    if (Result.isError(inspected)) {
      return Result.err(inspected.error);
    }
    if (inspected.value !== undefined) {
      installations.push(inspected.value);
    }
  }
  return Result.ok(installations);
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
    const { configDir, process: proc } = this;
    const inspected = await Result.gen(async function* inspectInstallation() {
      const channel = yield* Result.await(detectInstallChannel({ configDir }));
      const nativePath = yield* Result.await(
        resolveDoctorNativePath({
          configDir,
          defaultPath: path.join(
            os.homedir(),
            ".local",
            "bin",
            proc.platform === "win32" ? "stella.exe" : "stella",
          ),
          ...(channel === "native" ? { activeNativePath: proc.execPath } : {}),
        }),
      );
      const installations = yield* Result.await(
        inspectPathInstallations({
          pathValue: proc.env["PATH"] ?? "",
          nativePath,
          platform: proc.platform,
        }),
      );
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
        let fixed = false;
        if (nativeIndex > 0 && first?.channel === "npm") {
          const info = yield* Result.await(
            Result.tryPromise({
              try: () => lstat(first.path),
              catch: (cause) =>
                new DoctorError({
                  message: "Could not inspect the shadowing executable.",
                  cause,
                }),
            }),
          );
          if (info.isSymbolicLink()) {
            const backup = `${first.path}.stella-disabled`;
            const exists = await Result.tryPromise({
              try: () => lstat(backup),
              catch: (cause) => cause,
            });
            if (Result.isOk(exists)) {
              return Result.err(
                new DoctorError({
                  message: `Backup already exists: ${backup}; no change made.`,
                }),
              );
            }
            if (!hasFsErrorCode(exists.error, ["ENOENT"])) {
              return Result.err(
                new DoctorError({
                  message: "Could not inspect the shadowing executable backup.",
                  cause: exists.error,
                }),
              );
            }
            yield* Result.await(
              Result.tryPromise({
                try: () => rename(first.path, backup),
                catch: (cause) =>
                  new DoctorError({
                    message: "Could not disable the shadowing executable.",
                    cause,
                  }),
              }),
            );
            lines.push(
              `Disabled ${first.path}. Undo: mv '${backup.replaceAll("'", "'\\''")}' '${first.path.replaceAll("'", "'\\''")}'`,
            );
            fixed = true;
          }
        }
        if (!fixed) {
          lines.push(
            "No reversible PATH fix is available; use the migration command above.",
          );
        }
      }
      return Result.ok(lines);
    });
    if (Result.isError(inspected)) {
      return new CliCommandError(
        inspected.error.message,
        EXIT_CODES.validation,
      );
    }
    proc.stdout.write(`${inspected.value.join("\n")}\n`);
    return undefined;
  },
});
