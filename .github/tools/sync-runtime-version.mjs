import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$/;

const PACKAGE_FILES = [
  "packages/anonymize/package.json",
  "packages/anonymize-darwin-arm64/package.json",
  "packages/anonymize-darwin-x64/package.json",
  "packages/anonymize-linux-arm64-gnu/package.json",
  "packages/anonymize-linux-x64-gnu/package.json",
  "packages/anonymize-win32-x64-msvc/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
  "packages/document-docx/package.json",
  "packages/document-pdf/package.json",
  "packages/mcp/package.json",
];
const ROOT_RUNTIME_PACKAGE_FILE = "packages/anonymize/package.json";
const ROOT_NATIVE_OPTIONAL_DEPENDENCIES = [
  "@stll/anonymize-darwin-arm64",
  "@stll/anonymize-darwin-x64",
  "@stll/anonymize-linux-arm64-gnu",
  "@stll/anonymize-linux-x64-gnu",
  "@stll/anonymize-win32-x64-msvc",
];

const CARGO_WORKSPACE_MANIFEST = "Cargo.toml";
const PYPROJECT_FILES = ["crates/anonymize-py/pyproject.toml"];
const LOCK_FILE = "bun.lock";
const CARGO_LOCK_FILE = "Cargo.lock";
const checkOnly = process.argv.includes("--check");
const releaseMode = process.argv.includes("--release");
const version = readFileSync("VERSION", "utf8").trim();

if (!VERSION_RE.test(version)) {
  console.error(
    `VERSION must look like 1.2.3, 1.2.3-rc.1, 1.2.3-beta.1, or 1.2.3-alpha.1; got '${version}'`,
  );
  process.exit(1);
}

let hasMismatch = false;

// Internal dependency ranges that must track the synchronized runtime train.
const SYNCED_DEPENDENCIES = [
  "@stll/anonymize",
  "@stll/anonymize-docx",
  "@stll/anonymize-pdf",
];
// These consumers require APIs introduced by the same fixed release train.
// Source manifests use workspace:* so local development cannot silently fall
// back to an older published package. The release path resolves that marker to
// the exact synchronized version before packing or publishing.
const EXACT_CO_RELEASE_DEPENDENCIES = new Map([
  [
    "packages/mcp/package.json",
    new Set(["@stll/anonymize", "@stll/anonymize-pdf"]),
  ],
  ["packages/document-pdf/package.json", new Set(["@stll/anonymize"])],
]);

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Windows runners check out with CRLF line endings; the version regexes below
// anchor on "\n", so normalize before matching (files are written back LF-only).
const readTextFile = (file) =>
  readFileSync(file, "utf8").replaceAll("\r\n", "\n");

const cargoLockedPackages = inheritedWorkspacePackageNames();

const synchronizedDependencyRange = ({ dependencyRange, exactCoRelease }) => {
  if (!exactCoRelease) {
    return `^${version}`;
  }
  if (releaseMode) {
    return version;
  }
  return dependencyRange === "workspace:*" ? "workspace:*" : version;
};

const syncTextVersion = ({ file, label, re }) => {
  const text = readTextFile(file);
  const match = text.match(re);
  if (!match) {
    console.error(`${file} has no ${label} version entry`);
    hasMismatch = true;
    return;
  }
  const current = match[2];
  if (current === version) {
    return;
  }
  if (checkOnly) {
    console.error(
      `${file} has ${label} version ${current}; expected ${version}`,
    );
    hasMismatch = true;
    return;
  }
  writeFileSync(file, text.replace(re, `$1${version}$3`));
  console.log(`Updated ${file} ${label} version to ${version}`);
};

for (const file of PACKAGE_FILES) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const mismatchedDependencies = SYNCED_DEPENDENCIES.flatMap((dependency) => {
    const dependencyRange = pkg.dependencies?.[dependency];
    if (dependencyRange === undefined) {
      return [];
    }
    const exactCoRelease =
      EXACT_CO_RELEASE_DEPENDENCIES.get(file)?.has(dependency) === true;
    const validSourceRange =
      dependencyRange === "workspace:*" || dependencyRange === version;
    const wantedRange = synchronizedDependencyRange({
      dependencyRange,
      exactCoRelease,
    });
    if (
      dependencyRange === wantedRange ||
      (exactCoRelease && !releaseMode && validSourceRange)
    ) {
      return [];
    }
    return [{ dependency, dependencyRange, exactCoRelease, wantedRange }];
  });
  if (pkg.version === version && mismatchedDependencies.length === 0) {
    continue;
  }

  if (checkOnly) {
    if (pkg.version !== version) {
      console.error(`${file} has version ${pkg.version}; expected ${version}`);
    }
    for (const {
      dependency,
      dependencyRange,
      exactCoRelease,
      wantedRange,
    } of mismatchedDependencies) {
      console.error(
        `${file} depends on ${dependency}@${dependencyRange}; expected ${
          exactCoRelease && !releaseMode
            ? `workspace:* or ${version}`
            : wantedRange
        }`,
      );
    }
    hasMismatch = true;
    continue;
  }

  pkg.version = version;
  for (const { dependency, wantedRange } of mismatchedDependencies) {
    pkg.dependencies[dependency] = wantedRange;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Updated ${file} to ${version}`);
}

{
  const pkg = JSON.parse(readFileSync(ROOT_RUNTIME_PACKAGE_FILE, "utf8"));
  const wantedVersion = version;
  let changed = false;
  for (const dependency of ROOT_NATIVE_OPTIONAL_DEPENDENCIES) {
    const current = pkg.optionalDependencies?.[dependency];
    if (current === wantedVersion) {
      continue;
    }
    if (checkOnly) {
      console.error(
        `${ROOT_RUNTIME_PACKAGE_FILE} optional dependency ${dependency}@${current}; expected ${wantedVersion}`,
      );
      hasMismatch = true;
      continue;
    }
    pkg.optionalDependencies ??= {};
    pkg.optionalDependencies[dependency] = wantedVersion;
    changed = true;
  }
  if (changed) {
    writeFileSync(
      ROOT_RUNTIME_PACKAGE_FILE,
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    console.log(
      `Updated ${ROOT_RUNTIME_PACKAGE_FILE} native optional dependency versions to ${wantedVersion}`,
    );
  }
}

syncTextVersion({
  file: CARGO_WORKSPACE_MANIFEST,
  label: "Cargo workspace",
  re: /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
});

for (const file of PYPROJECT_FILES) {
  const text = readTextFile(file);
  const explicitVersion = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (explicitVersion) {
    syncTextVersion({
      file,
      label: "Python project",
      re: /(^version\s*=\s*")([^"]+)(")/m,
    });
    continue;
  }

  if (/\bdynamic\s*=\s*\[[^\]]*"version"[^\]]*\]/m.test(text)) {
    continue;
  }

  console.error(
    `${file} must either derive version dynamically from Cargo or match VERSION`,
  );
  hasMismatch = true;
}

const lockText = readTextFile(LOCK_FILE);
let lockChanged = false;
let syncedLockText = lockText;

for (const dependency of SYNCED_DEPENDENCIES) {
  const syncedDependency = syncDependencyRangeLockVersion(
    syncedLockText,
    dependency,
  );
  syncedLockText = syncedDependency.text;
  lockChanged ||= syncedDependency.changed;
  hasMismatch ||= syncedDependency.hasMismatch;
}

for (const [file, dependencies] of EXACT_CO_RELEASE_DEPENDENCIES) {
  const workspace = dirname(file);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const dependency of dependencies) {
    const expectedRange = pkg.dependencies?.[dependency];
    if (expectedRange !== "workspace:*" && expectedRange !== version) {
      console.error(
        `${file} has invalid exact co-release dependency ${dependency}@${expectedRange}`,
      );
      hasMismatch = true;
      continue;
    }
    const syncedDependency = syncWorkspaceDependencyLockRange(
      syncedLockText,
      workspace,
      dependency,
      expectedRange,
    );
    syncedLockText = syncedDependency.text;
    lockChanged ||= syncedDependency.changed;
    hasMismatch ||= syncedDependency.hasMismatch;
  }
}

for (const dependency of ROOT_NATIVE_OPTIONAL_DEPENDENCIES) {
  const syncedSidecar = syncNativeOptionalDependencyLockVersion(
    syncedLockText,
    dependency,
  );
  syncedLockText = syncedSidecar.text;
  lockChanged ||= syncedSidecar.changed;
  hasMismatch ||= syncedSidecar.hasMismatch;
}

for (const file of PACKAGE_FILES) {
  const workspace = dirname(file);
  const workspaceVersionRe = new RegExp(
    `("${escapeRegExp(workspace)}": \\{\\n\\s+"name": "[^"]+",\\n\\s+"version": ")([^"]+)(")`,
  );
  const match = syncedLockText.match(workspaceVersionRe);
  if (!match) {
    console.error(
      `${LOCK_FILE} has no version entry for workspace ${workspace}`,
    );
    hasMismatch = true;
    continue;
  }
  const lockedVersion = match[2];
  if (lockedVersion === version) {
    continue;
  }
  if (checkOnly) {
    console.error(
      `${LOCK_FILE} workspace ${workspace} has version ${lockedVersion}; expected ${version}`,
    );
    hasMismatch = true;
    continue;
  }
  syncedLockText = syncedLockText.replace(workspaceVersionRe, `$1${version}$3`);
  lockChanged = true;
}

if (lockChanged) {
  writeFileSync(LOCK_FILE, syncedLockText);
  console.log(
    `Updated ${LOCK_FILE} workspace versions and runtime dependency ranges to ${version}`,
  );
}

const cargoLockText = readTextFile(CARGO_LOCK_FILE);
let cargoLockChanged = false;
let syncedCargoLockText = cargoLockText;

for (const packageName of cargoLockedPackages) {
  const packageVersionRe = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")([^"]+)(")`,
  );
  const match = syncedCargoLockText.match(packageVersionRe);
  if (!match) {
    console.error(`${CARGO_LOCK_FILE} has no package entry for ${packageName}`);
    hasMismatch = true;
    continue;
  }
  const lockedVersion = match[2];
  if (lockedVersion === version) {
    continue;
  }
  if (checkOnly) {
    console.error(
      `${CARGO_LOCK_FILE} package ${packageName} has version ${lockedVersion}; expected ${version}`,
    );
    hasMismatch = true;
    continue;
  }
  syncedCargoLockText = syncedCargoLockText.replace(
    packageVersionRe,
    `$1${version}$3`,
  );
  cargoLockChanged = true;
}

if (cargoLockChanged) {
  writeFileSync(CARGO_LOCK_FILE, syncedCargoLockText);
  console.log(
    `Updated ${CARGO_LOCK_FILE} local package versions to ${version}`,
  );
}

if (hasMismatch) {
  process.exit(1);
}

/** Discover every root-workspace package whose version explicitly inherits
 * `[workspace.package].version`. Cargo.lock records those packages with the
 * synchronized version, so deriving this set prevents a newly added crate from
 * being omitted by a manually maintained release allowlist. */
function inheritedWorkspacePackageNames() {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--locked", "--format-version", "1"],
      { encoding: "utf8" },
    ),
  );
  const workspaceMembers = new Set(metadata.workspace_members);
  const packageNames = [];
  for (const cargoPackage of metadata.packages) {
    if (!workspaceMembers.has(cargoPackage.id)) {
      continue;
    }
    const packageSection = cargoPackageTable(cargoPackage.manifest_path);
    const inheritsVersion =
      /^version\.workspace\s*=\s*true\s*$/m.test(packageSection) ||
      /^version\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b[^}]*\}\s*$/m.test(
        packageSection,
      );
    if (!inheritsVersion) {
      continue;
    }
    packageNames.push(cargoPackage.name);
  }

  if (packageNames.length === 0) {
    throw new Error(
      `${CARGO_WORKSPACE_MANIFEST} has no members inheriting workspace version`,
    );
  }
  return packageNames.sort((left, right) => left.localeCompare(right, "en"));
}

function cargoPackageTable(manifestFile) {
  const text = readTextFile(manifestFile);
  const header = /^\[package\]\s*$/m;
  const match = header.exec(text);
  if (!match) {
    throw new Error(`${manifestFile} has no [package] table`);
  }
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const nextTable = remainder.search(/^\s*\[/m);
  return nextTable === -1 ? remainder : remainder.slice(0, nextTable);
}

function syncNativeOptionalDependencyLockVersion(text, dependency) {
  const sidecarVersionRe = new RegExp(
    `("${escapeRegExp(dependency)}": ")([^"]+)(")`,
    "g",
  );
  let found = false;
  let changed = false;
  let mismatched = false;
  const syncedText = text.replaceAll(
    sidecarVersionRe,
    (match, prefix, lockedVersion, suffix) => {
      found = true;
      if (lockedVersion === version) {
        return match;
      }
      if (checkOnly) {
        console.error(
          `${LOCK_FILE} has ${dependency}@${lockedVersion}; expected ${version}`,
        );
        mismatched = true;
        return match;
      }
      changed = true;
      return `${prefix}${version}${suffix}`;
    },
  );
  if (!found) {
    console.error(`${LOCK_FILE} has no optional dependency ${dependency}`);
    mismatched = true;
  }
  return {
    text: syncedText,
    changed,
    hasMismatch: mismatched,
  };
}

function syncDependencyRangeLockVersion(text, dependency) {
  const dependencyRangeRe = new RegExp(
    `("${escapeRegExp(dependency)}": "\\^)([^"]+)(")`,
    "g",
  );
  let found = false;
  let changed = false;
  let mismatched = false;
  const syncedText = text.replaceAll(
    dependencyRangeRe,
    (match, prefix, lockedVersion, suffix) => {
      found = true;
      if (lockedVersion === version) {
        return match;
      }
      if (checkOnly) {
        console.error(
          `${LOCK_FILE} has ${dependency}@^${lockedVersion}; expected ^${version}`,
        );
        mismatched = true;
        return match;
      }
      changed = true;
      return `${prefix}${version}${suffix}`;
    },
  );
  if (!found) {
    console.error(`${LOCK_FILE} has no dependency range for ${dependency}`);
    mismatched = true;
  }
  return {
    text: syncedText,
    changed,
    hasMismatch: mismatched,
  };
}

function syncWorkspaceDependencyLockRange(
  text,
  workspace,
  dependency,
  expectedRange,
) {
  let dependencyProperty;
  try {
    // Validate the complete JSONC-shaped lock first. Bun currently emits JSON
    // with trailing commas but no comments; stripping only commas immediately
    // before a closing delimiter matches the lockfile guard used elsewhere in
    // this repository.
    JSON.parse(text.replaceAll(/,\s*([}\]])/g, "$1"));
    const rootStart = skipJsonWhitespace(text, 0);
    const root = requireDirectObjectProperty(text, rootStart, "workspaces");
    const workspaceProperty = requireDirectObjectProperty(
      text,
      root.valueStart,
      workspace,
    );
    const dependencies = requireDirectObjectProperty(
      text,
      workspaceProperty.valueStart,
      "dependencies",
    );
    dependencyProperty = requireDirectStringProperty(
      text,
      dependencies.valueStart,
      dependency,
    );
  } catch (error) {
    console.error(
      `${LOCK_FILE} cannot resolve ${dependency} inside workspace ${workspace}: ${
        error instanceof Error ? error.message : "invalid lock structure"
      }`,
    );
    return { text, changed: false, hasMismatch: true };
  }
  const currentRange = JSON.parse(
    text.slice(dependencyProperty.valueStart, dependencyProperty.valueEnd),
  );
  if (currentRange === expectedRange) {
    return { text, changed: false, hasMismatch: false };
  }
  if (checkOnly) {
    console.error(
      `${LOCK_FILE} workspace ${workspace} has ${dependency}@${currentRange}; expected ${expectedRange}`,
    );
    return { text, changed: false, hasMismatch: true };
  }
  return {
    text: `${text.slice(0, dependencyProperty.valueStart)}${JSON.stringify(expectedRange)}${text.slice(dependencyProperty.valueEnd)}`,
    changed: true,
    hasMismatch: false,
  };
}

function skipJsonWhitespace(text, start) {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function scanJsonStringEnd(text, start) {
  if (text[start] !== '"') {
    throw new Error("expected a JSON string");
  }
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') {
      return index + 1;
    }
  }
  throw new Error("unterminated JSON string");
}

function scanJsonCompositeEnd(text, start) {
  const stack = [text[start]];
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      index = scanJsonStringEnd(text, index) - 1;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      const opening = stack.pop();
      if (
        (opening === "{" && character !== "}") ||
        (opening === "[" && character !== "]")
      ) {
        throw new Error("mismatched JSON delimiters");
      }
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }
  throw new Error("unterminated JSON object or array");
}

function scanJsonValueEnd(text, start) {
  if (text[start] === '"') {
    return scanJsonStringEnd(text, start);
  }
  if (text[start] === "{" || text[start] === "[") {
    return scanJsonCompositeEnd(text, start);
  }
  let index = start;
  while (
    index < text.length &&
    text[index] !== "," &&
    text[index] !== "}" &&
    text[index] !== "]"
  ) {
    index += 1;
  }
  while (index > start && /\s/u.test(text[index - 1] ?? "")) {
    index -= 1;
  }
  return index;
}

function directJsonObjectProperties(text, objectStart) {
  if (text[objectStart] !== "{") {
    throw new Error("expected a JSON object");
  }
  const objectEnd = scanJsonCompositeEnd(text, objectStart);
  const properties = [];
  let index = objectStart + 1;
  while (index < objectEnd - 1) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === ",") {
      index = skipJsonWhitespace(text, index + 1);
    }
    if (index >= objectEnd - 1) {
      break;
    }
    const keyEnd = scanJsonStringEnd(text, index);
    const key = JSON.parse(text.slice(index, keyEnd));
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") {
      throw new Error("expected a JSON property separator");
    }
    const valueStart = skipJsonWhitespace(text, index + 1);
    const valueEnd = scanJsonValueEnd(text, valueStart);
    properties.push({ key, valueEnd, valueStart });
    index = valueEnd;
  }
  return properties;
}

function requireDirectProperty(text, objectStart, property) {
  const matches = directJsonObjectProperties(text, objectStart).filter(
    ({ key }) => key === property,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one direct ${JSON.stringify(property)} property`,
    );
  }
  return matches[0];
}

function requireDirectObjectProperty(text, objectStart, property) {
  const match = requireDirectProperty(text, objectStart, property);
  if (text[match.valueStart] !== "{") {
    throw new Error(`${JSON.stringify(property)} must be an object`);
  }
  return match;
}

function requireDirectStringProperty(text, objectStart, property) {
  const match = requireDirectProperty(text, objectStart, property);
  if (text[match.valueStart] !== '"') {
    throw new Error(`${JSON.stringify(property)} must be a string`);
  }
  return match;
}
