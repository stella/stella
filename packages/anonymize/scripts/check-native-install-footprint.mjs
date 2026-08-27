import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const MEBIBYTE = 1024 * 1024;
const MAX_NATIVE_INSTALL_BYTES = 85 * MEBIBYTE;
const DATA_PACKAGE_NAME = "@stll/anonymize-data";
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);

if (packageManifest.optionalDependencies?.["@stll/anonymize-wasm"]) {
  throw new Error(
    "@stll/anonymize must not install the browser WASM runtime as an optional dependency",
  );
}
const runtimeDependencies = Object.keys(packageManifest.dependencies ?? {});
if (
  runtimeDependencies.length !== 1 ||
  runtimeDependencies.at(0) !== DATA_PACKAGE_NAME
) {
  throw new Error(
    `native install footprint expects ${DATA_PACKAGE_NAME} as its only runtime dependency`,
  );
}

const sidecarDirectory = resolveSidecarDirectory(process.argv.at(2));
const sidecarManifest = JSON.parse(
  readFileSync(join(sidecarDirectory, "package.json"), "utf8"),
);
if (
  typeof sidecarManifest.name !== "string" ||
  packageManifest.optionalDependencies?.[sidecarManifest.name] === undefined
) {
  throw new Error(
    `${sidecarDirectory} is not a native optional dependency of @stll/anonymize`,
  );
}

const sidecarName = basename(sidecarDirectory);
const dataDirectory = join(repoRoot, "packages", "data");
const dataManifest = JSON.parse(
  readFileSync(join(dataDirectory, "package.json"), "utf8"),
);
if (dataManifest.name !== DATA_PACKAGE_NAME) {
  throw new Error(`${dataDirectory} must contain ${DATA_PACKAGE_NAME}`);
}
const rootBytes = packedUnpackedBytes(packageRoot);
const sidecarBytes = packedUnpackedBytes(sidecarDirectory);
const dataBytes = packedUnpackedBytes(dataDirectory);
const installedBytes = rootBytes + sidecarBytes + dataBytes;

if (installedBytes > MAX_NATIVE_INSTALL_BYTES) {
  throw new Error(
    `packed native install is ${formatMebibytes(installedBytes)}, above the ${formatMebibytes(MAX_NATIVE_INSTALL_BYTES)} ceiling`,
  );
}

console.log(
  JSON.stringify({
    event: "native-install-footprint",
    maxMiB: MAX_NATIVE_INSTALL_BYTES / MEBIBYTE,
    nativeSidecar: sidecarName,
    ok: true,
    packedUnpackedMiB: Number((installedBytes / MEBIBYTE).toFixed(1)),
    runtimeDependencies: [DATA_PACKAGE_NAME],
  }),
);

function packedUnpackedBytes(directory) {
  const output = execFileSync(
    npmExecutable,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: directory,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  const pack = JSON.parse(output).at(0);
  if (!pack || typeof pack.unpackedSize !== "number") {
    throw new Error(`npm did not report an unpacked size for ${directory}`);
  }
  return pack.unpackedSize;
}

function nativeSidecarName() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "anonymize-darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "anonymize-darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "anonymize-linux-arm64-gnu";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "anonymize-linux-x64-gnu";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "anonymize-win32-x64-msvc";
  }
  throw new Error(
    `native install footprint is unsupported on ${process.platform}-${process.arch}`,
  );
}

function resolveSidecarDirectory(requestedDirectory) {
  const packagesRoot = join(repoRoot, "packages");
  const directory =
    requestedDirectory === undefined
      ? join(packagesRoot, nativeSidecarName())
      : resolve(repoRoot, requestedDirectory);
  const relativeDirectory = relative(packagesRoot, directory);
  if (
    relativeDirectory.length === 0 ||
    isAbsolute(relativeDirectory) ||
    relativeDirectory.startsWith("..") ||
    basename(relativeDirectory) !== relativeDirectory
  ) {
    throw new Error(
      `native sidecar must be a direct child of ${packagesRoot}: ${directory}`,
    );
  }
  return directory;
}

function formatMebibytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}
