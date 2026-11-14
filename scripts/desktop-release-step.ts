import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

class DesktopReleaseStepError extends Error {
  override name = "DesktopReleaseStepError";
  readonly _tag = "DesktopReleaseStepError";
}

// Release tooling can run before dependencies exist in the checked-out source.
class DesktopReleaseStepInvariantError extends Error {
  override name = "DesktopReleaseStepInvariantError";
  readonly _tag = "DesktopReleaseStepInvariantError";
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
  stampCargoPackageVersion(path.dirname(cargoPath), version);
};

const singleMatch = (
  source: string,
  pattern: RegExp,
  what: string,
): RegExpMatchArray => {
  const matches = [...source.matchAll(pattern)];
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new DesktopReleaseStepError(
      `Expected exactly one ${what}, found ${matches.length}`,
    );
  }
  return match;
};

// The package version lives in the manifest and in the lockfile entry of the
// workspace root. Both change together, so `--locked` cargo commands accept the
// stamped tree and no build rewrites the committed lockfile.
export const stampCargoPackageVersion = (
  crateDir: string,
  version: string,
): void => {
  const manifestPath = path.join(crateDir, "Cargo.toml");
  const lockPath = path.join(crateDir, "Cargo.lock");
  const manifest = readFileSync(manifestPath, "utf-8");
  const lock = readFileSync(lockPath, "utf-8");
  const packageHeader = singleMatch(
    manifest,
    /^\[package\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gmu,
    "[package] name and version in Cargo.toml",
  );
  const [, name, previous] = packageHeader;
  if (name === undefined || previous === undefined) {
    throw new DesktopReleaseStepInvariantError("Unmatched package header");
  }
  const lockEntry = singleMatch(
    lock,
    new RegExp(
      `^\\[\\[package\\]\\]\\r?\\nname = "${RegExp.escape(name)}"\\r?\\nversion = "${RegExp.escape(previous)}"(?=\\r?\\n)`,
      "gmu",
    ),
    `Cargo.lock entry for ${name} ${previous}`,
  );
  const stamp = (source: string, match: RegExpMatchArray): string => {
    const [matched] = match;
    if (match.index === undefined) {
      throw new DesktopReleaseStepInvariantError("Unmatched version line");
    }
    const stamped = matched.replace(
      /version = "[^"]+"$/u,
      () => `version = "${version}"`,
    );
    return `${source.slice(0, match.index)}${stamped}${source.slice(match.index + matched.length)}`;
  };
  writeFileSync(manifestPath, stamp(manifest, packageHeader));
  writeFileSync(lockPath, stamp(lock, lockEntry));
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

type SignerRun = { cwd: string; file: string; appVersion: string };
type CommandRunner = (signing: SignerRun) => void;

type ResignWindowsArtifactsOptions = {
  bundleDir: string;
  appVersion: string;
  run: CommandRunner;
};

export const resignWindowsArtifacts = ({
  bundleDir,
  appVersion,
  run,
}: ResignWindowsArtifactsOptions): void => {
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
    run({
      cwd: path.dirname(installer),
      file: path.basename(installer),
      appVersion,
    });
    // Azure changes the binary hash; refresh the updater signature only when Tauri emitted its zip.
    const zip = `${installer}.zip`;
    if (existsSync(zip)) {
      run({ cwd: path.dirname(zip), file: path.basename(zip), appVersion });
    }
  }
};

/** The version `stamp` wrote into the config the bundler built from. */
const readStampedAppVersion = (configPath: string): string => {
  const config: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
  const version =
    typeof config === "object" && config !== null && "version" in config
      ? config.version
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw new DesktopReleaseStepError(`${configPath} has no app version`);
  }
  return version;
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

// The trusted comment binds the signature to its release version; clients
// with `requireSignedVersion` refuse an updater signature without it.
const runTauriSigner: CommandRunner = ({ cwd, file, appVersion }) => {
  const result = Bun.spawnSync(
    [
      "bun",
      "x",
      "@tauri-apps/cli",
      "signer",
      "sign",
      "--app-version",
      appVersion,
      file,
    ],
    { cwd, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new DesktopReleaseStepError(`Failed to sign ${file}`);
  }
};

type DesktopReleaseCommand =
  "stamp" | "configure-windows" | "resign" | "upload";

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
      resignWindowsArtifacts({
        bundleDir: required(args.at(0), "bundle directory"),
        appVersion: readStampedAppVersion("src-tauri/tauri.conf.json"),
        run: runTauriSigner,
      });
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
      throw new DesktopReleaseStepInvariantError(
        "Unhandled desktop release command",
      );
    }
  }
}
