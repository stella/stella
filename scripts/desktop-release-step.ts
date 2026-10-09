import { panic } from "better-result";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

class DesktopReleaseStepError extends Error {
  override name = "DesktopReleaseStepError";
  readonly _tag = "DesktopReleaseStepError";
}

const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value === "") {
    throw new DesktopReleaseStepError(`Missing ${name}`);
  }
  return value;
};

export const stampDesktopRelease = (
  root: string,
  version: string,
  channel: string,
): void => {
  const configPath = path.join(root, "apps/desktop/src-tauri/tauri.conf.json");
  const cargoPath = path.join(root, "apps/desktop/src-tauri/Cargo.toml");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  config.version = version;
  // The updater endpoint is pinned per channel so prerelease builds never poll production.
  config.plugins.updater.endpoints = [
    `https://downloads.stll.app/desktop/${channel || "prod"}/latest.json`,
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const cargo = readFileSync(cargoPath, "utf-8").replace(
    /^version = "[^"]+"/mu,
    () => `version = "${version}"`,
  );
  writeFileSync(cargoPath, cargo);
};

export const configureWindowsSigning = (
  configPath: string,
  mode: string,
  env: NodeJS.ProcessEnv,
): void => {
  if (mode !== "release" && mode !== "dry-run") {
    throw new DesktopReleaseStepError(
      `Unknown configure-windows mode: ${mode}`,
    );
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (mode === "release") {
    const endpoint = required(env["AZURE_ENDPOINT"], "AZURE_ENDPOINT");
    const account = required(
      env["AZURE_CODE_SIGNING_ACCOUNT"],
      "AZURE_CODE_SIGNING_ACCOUNT",
    );
    const profile = required(env["AZURE_CERT_PROFILE"], "AZURE_CERT_PROFILE");
    config.bundle.windows.signCommand = `trusted-signing-cli -e ${endpoint} -a ${account} -c ${profile} %1`;
  } else {
    // A dry run has no updater signing key; Tauri fails the build when it
    // must sign updater artifacts without one.
    delete config.bundle.windows.signCommand;
    config.bundle.createUpdaterArtifacts = false;
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

type CommandRunner = (cwd: string, file: string) => void;

export const resignWindowsArtifacts = (
  bundleDir: string,
  run: CommandRunner,
): void => {
  const directories = [
    path.join(bundleDir, "msi"),
    path.join(bundleDir, "nsis"),
  ];
  const installers = directories.flatMap((directory) =>
    existsSync(directory)
      ? readdirSync(directory)
          .filter(
            (file) => file.endsWith(".msi") || file.endsWith("-setup.exe"),
          )
          .map((file) => path.join(directory, file))
      : [],
  );
  if (installers.length === 0) {
    throw new DesktopReleaseStepError(
      `No Windows installers found under ${bundleDir}`,
    );
  }
  for (const installer of installers) {
    run(path.dirname(installer), path.basename(installer));
    // Azure changes the binary hash; refresh the updater signature only when Tauri emitted its zip.
    const zip = `${installer}.zip`;
    if (existsSync(zip)) {
      run(path.dirname(zip), path.basename(zip));
    }
  }
};

export const desktopArtifacts = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return [];
  }
  const artifacts: string[] = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) {
      artifacts.push(...desktopArtifacts(candidate));
    } else if (entry.startsWith("Stella-")) {
      artifacts.push(candidate);
    }
  }
  return artifacts.toSorted();
};

const runTauriSigner: CommandRunner = (cwd, file) => {
  const result = Bun.spawnSync(
    ["bun", "x", "@tauri-apps/cli", "signer", "sign", file],
    { cwd, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new DesktopReleaseStepError(`Failed to sign ${file}`);
  }
};

type DesktopReleaseCommand =
  | "stamp"
  | "configure-windows"
  | "resign"
  | "upload";

const isDesktopReleaseCommand = (
  command: string,
): command is DesktopReleaseCommand => {
  switch (command) {
    case "stamp":
    case "configure-windows":
    case "resign":
    case "upload":
      return true;
    default:
      return false;
  }
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== undefined && !isDesktopReleaseCommand(command)) {
    throw new DesktopReleaseStepError(
      `Unknown desktop release command: ${command}`,
    );
  }
  switch (command) {
    case undefined:
      throw new DesktopReleaseStepError("Missing desktop release command");
    case "stamp":
      stampDesktopRelease(
        process.cwd(),
        required(process.env["VERSION"], "VERSION"),
        process.env["CHANNEL"] ?? "prod",
      );
      break;
    case "configure-windows":
      configureWindowsSigning(
        required(args.at(1), "config path"),
        required(args.at(0), "mode"),
        process.env,
      );
      break;
    case "resign":
      resignWindowsArtifacts(
        required(args.at(0), "bundle directory"),
        runTauriSigner,
      );
      break;
    case "upload": {
      const bundle = required(args.at(0), "bundle directory");
      const artifacts = desktopArtifacts(bundle);
      if (artifacts.length === 0) {
        throw new DesktopReleaseStepError(
          `No desktop artifacts found under ${bundle}`,
        );
      }
      const retry = required(process.env["GH_RETRY_SCRIPT"], "GH_RETRY_SCRIPT");
      const release = required(process.env["RELEASE_REF"], "RELEASE_REF");
      const result = Bun.spawnSync(
        [
          "bash",
          retry,
          "release",
          "upload",
          release,
          ...artifacts,
          "--clobber",
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      if (result.exitCode !== 0) {
        throw new DesktopReleaseStepError("Desktop artifact upload failed");
      }
      break;
    }
    default: {
      command satisfies never;
      panic("Unhandled desktop release command");
    }
  }
}
