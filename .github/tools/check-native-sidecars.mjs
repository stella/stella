import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT_PACKAGE = "packages/anonymize";
const NATIVE_BINARY = "stella_anonymize_napi.node";
const SIDECAR_PREFIX = "anonymize-";
const SIDECAR_SCOPE = "@stll/anonymize-";

const rootPackage = readJson(join(ROOT_PACKAGE, "package.json"));
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const packlistTool = readFileSync(".github/tools/check-packlist.mjs", "utf8");
const sidecars = discoverSidecars();

let failed = false;

if (sidecars.length === 0) {
  fail("No native sidecar packages found");
}

const expectedOptionalDependencies = Object.fromEntries(
  sidecars.map((sidecar) => [sidecar.packageJson.name, rootPackage.version]),
);

assertExactObject(
  rootPackage.optionalDependencies ?? {},
  expectedOptionalDependencies,
  `${ROOT_PACKAGE}/package.json optionalDependencies`,
);

for (const sidecar of sidecars) {
  assertSidecarPackage(sidecar);
  assertReleaseMatrix(sidecar);
}

if (!packlistTool.includes(`forbidden: ["${NATIVE_BINARY}"]`)) {
  fail(`Root packlist check must forbid ${NATIVE_BINARY}`);
}

if (failed) {
  process.exit(1);
}

function discoverSidecars() {
  return readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(SIDECAR_PREFIX))
    .map((directory) => {
      const packagePath = join("packages", directory, "package.json");
      return {
        directory,
        packagePath,
        packageJson: readJson(packagePath),
        target: parseTarget(directory),
      };
    })
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function assertSidecarPackage(sidecar) {
  const { directory, packageJson, target } = sidecar;
  const expectedName = `${SIDECAR_SCOPE}${target.name}`;
  assertEqual(packageJson.name, expectedName, `${directory} name`);
  assertEqual(packageJson.version, rootPackage.version, `${directory} version`);
  assertEqual(packageJson.main, "index.cjs", `${directory} main`);
  assertArrayEqual(
    packageJson.files,
    ["index.cjs", NATIVE_BINARY],
    `${directory} files`,
  );
  assertArrayEqual(packageJson.os, [target.os], `${directory} os`);
  assertArrayEqual(packageJson.cpu, [target.cpu], `${directory} cpu`);
  if (target.libc === undefined) {
    if (packageJson.libc !== undefined) {
      fail(`${directory} must not declare libc`);
    }
  } else {
    assertArrayEqual(packageJson.libc, [target.libc], `${directory} libc`);
  }
}

function assertReleaseMatrix(sidecar) {
  const matrixEntry = `package: packages/${sidecar.directory}`;
  if (!releaseWorkflow.includes(matrixEntry)) {
    fail(`release.yml is missing matrix entry ${matrixEntry}`);
  }
  const artifact = `npm-tarball-${sidecar.packageJson.name
    .replace(/^@/, "")
    .replaceAll("/", "-")}`;
  if (!releaseWorkflow.includes(`- ${artifact}`)) {
    fail(`release.yml publish-native matrix is missing ${artifact}`);
  }
}

function parseTarget(directory) {
  const target = directory.slice(SIDECAR_PREFIX.length);
  const parts = target.split("-");
  const platform = parts.at(0);
  if (platform === "darwin") {
    const cpu = parts.at(1);
    assertKnownTarget(directory, parts.length === 2 && isDarwinCpu(cpu));
    return { name: target, os: "darwin", cpu };
  }
  if (platform === "linux") {
    const cpu = parts.at(1);
    const libc = parts.at(2);
    assertKnownTarget(
      directory,
      parts.length === 3 && isLinuxCpu(cpu) && libc === "gnu",
    );
    return { name: target, os: "linux", cpu, libc: "glibc" };
  }
  if (platform === "win32") {
    const cpu = parts.at(1);
    const abi = parts.at(2);
    assertKnownTarget(
      directory,
      parts.length === 3 && cpu === "x64" && abi === "msvc",
    );
    return { name: target, os: "win32", cpu };
  }
  fail(`Unsupported native sidecar target: ${directory}`);
  return { name: target, os: "unsupported", cpu: "unsupported" };
}

function isDarwinCpu(value) {
  return value === "arm64" || value === "x64";
}

function isLinuxCpu(value) {
  return value === "arm64" || value === "x64";
}

function assertKnownTarget(directory, condition) {
  if (!condition) {
    fail(`Unsupported native sidecar target: ${directory}`);
    return;
  }
}

function assertExactObject(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assertArrayEqual(actualKeys, expectedKeys, `${label} keys`);
  for (const key of expectedKeys) {
    assertEqual(actual[key], expected[key], `${label}.${key}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected.at(index))
  ) {
    fail(
      `${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(
      `${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  failed = true;
  console.error(message);
}
