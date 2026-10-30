import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

const InstallChannelErrorBase: TaggedErrorClass<"InstallChannelError"> =
  TaggedError("InstallChannelError");
export class InstallChannelError extends InstallChannelErrorBase<{
  message: string;
  cause?: unknown;
}> {}

export type InstallChannel = "native" | "npm" | "homebrew";

export const upgradeCommandFor = (channel: InstallChannel): string => {
  switch (channel) {
    case "native":
      return "stella update";
    case "npm":
      return "npm i -g @stll/cli@latest";
    case "homebrew":
      return "brew upgrade stella";
  }
};

export const channelForPath = (
  executablePath: string,
): InstallChannel | undefined => {
  const normalized = executablePath.replaceAll("\\", "/");
  if (normalized.includes("/node_modules/") || normalized.includes("/npm/")) {
    return "npm";
  }
  if (normalized.includes("/Cellar/") || normalized.includes("/homebrew/")) {
    return "homebrew";
  }
  return undefined;
};

type DetectInstallChannelOptions = {
  configDir: string;
  executablePath?: string;
  entrypoint?: string;
};

export const detectInstallChannel = async ({
  configDir,
  executablePath = process.execPath,
  entrypoint = process.argv[1] ?? "",
}: DetectInstallChannelOptions): Promise<
  Result<InstallChannel, InstallChannelError>
> => {
  const inferred = channelForPath(entrypoint) ?? channelForPath(executablePath);
  if (inferred !== undefined) {
    return Result.ok(inferred);
  }
  const marker = await Result.tryPromise({
    try: () => readFile(path.join(configDir, "install-channel"), "utf-8"),
    catch: (cause) => cause,
  });
  if (Result.isError(marker)) {
    if (
      typeof marker.error === "object" &&
      marker.error !== null &&
      "code" in marker.error &&
      marker.error.code === "ENOENT"
    ) {
      return Result.ok("npm");
    }
    return Result.err(
      new InstallChannelError({
        message: "Could not read the installation channel.",
        cause: marker.error,
      }),
    );
  }
  const channel = marker.value.trim();
  if (channel === "native") {
    // The marker belongs to the native executable, never the Node/Bun runtime
    // used to launch a source checkout or an npm shim.
    const executableName = path.basename(executablePath);
    return Result.ok(
      executableName === "stella" || executableName === "stella.exe"
        ? "native"
        : "npm",
    );
  }
  if (channel === "npm" || channel === "homebrew") {
    return Result.ok(channel);
  }
  return Result.err(
    new InstallChannelError({
      message: "The installation channel record is invalid.",
    }),
  );
};

export const backgroundUpdateCheckEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env["CI"] === undefined && env["STELLA_NO_UPDATE_CHECK"] !== "1";
