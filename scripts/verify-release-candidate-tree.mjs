#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const MAX_CHANGED_DATA_BYTES = 2 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:rc|beta|alpha)\.[0-9]+)?$/u;
const PACKAGE_JSON_PATTERN = /^packages\/[^/]+\/package\.json$/u;
const DATA_PATH_PATTERNS = [
  /^\.changeset\/[^/]+\.md$/u,
  /^docs\/changelog\/v[^/]+\.md$/u,
  /^packages\/[^/]+\/CHANGELOG\.md$/u,
];
const FIXED_DATA_PATHS = new Set([
  "VERSION",
  "apps/landing/public/media/products/recordings-manifest.json",
  "apps/landing/src/data/changelog-release-dates.json",
]);

/**
 * @param {string} message Refusal reason written to stderr.
 * @returns {never} This function always exits the process.
 */
const refuse = (message) => {
  process.stderr.write(`RELEASE_CANDIDATE_TREE_REFUSED: ${message}\n`);
  process.exit(1);
};

const mainSha = process.argv[2] ?? "";
const candidateSha = process.argv[3] ?? "";
if (!SHA_PATTERN.test(mainSha) || !SHA_PATTERN.test(candidateSha)) {
  refuse("expected full lowercase main and candidate SHAs");
}

/**
 * @param {...string} args Arguments passed to Git.
 * @returns {string} Git stdout decoded as UTF-8.
 */
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * @param {string} sha Commit whose file is read.
 * @param {string} path Repository-relative file path.
 * @returns {string} File contents at the requested commit.
 */
const show = (sha, path) => git("show", `${sha}:${path}`);

/**
 * @param {string} value JSON source text.
 * @param {string} path Path named in a parse failure.
 * @returns {unknown} Parsed JSON value.
 */
const parseJson = (value, path) => {
  try {
    return JSON.parse(value);
  } catch {
    return refuse(`${path} is not valid JSON`);
  }
};

/**
 * @param {unknown} value Value to inspect.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {string} left Left technical key.
 * @param {string} right Right technical key.
 * @returns {number} Code-unit ordering for the two keys.
 */
const compareCodeUnit = (left, right) =>
  left < right ? -1 : Number(left > right);

try {
  execFileSync("git", ["merge-base", "--is-ancestor", mainSha, candidateSha], {
    stdio: "ignore",
  });
} catch {
  refuse("candidate does not contain the current main commit");
}

const changedPaths = git(
  "diff",
  "--name-only",
  "-z",
  mainSha.concat("..", candidateSha),
)
  .split("\0")
  .filter(Boolean);
if (!changedPaths.includes("VERSION")) {
  refuse("candidate does not change VERSION");
}

const packagePaths = /** @type {string[]} */ ([]);
let changedDataBytes = 0;
for (const path of changedPaths) {
  if (PACKAGE_JSON_PATTERN.test(path)) {
    packagePaths.push(path);
  } else if (
    path !== "bun.lock" &&
    !FIXED_DATA_PATHS.has(path) &&
    !DATA_PATH_PATTERNS.some((pattern) => pattern.test(path))
  ) {
    refuse(`executable or unrecognized path changed: ${path}`);
  }

  const treeEntry = git("ls-tree", candidateSha, "--", path).trim();
  if (treeEntry.length === 0) {
    continue;
  }
  if (!treeEntry.startsWith("100644 blob ")) {
    refuse(`candidate data path is not a regular non-executable file: ${path}`);
  }
  changedDataBytes += Number(
    git("cat-file", "-s", candidateSha.concat(":", path)),
  );
  if (
    !Number.isSafeInteger(changedDataBytes) ||
    changedDataBytes > MAX_CHANGED_DATA_BYTES
  ) {
    refuse("candidate release data exceeds the 2 MiB review bound");
  }
}

const candidateVersion = show(candidateSha, "VERSION").trim();
if (!VERSION_PATTERN.test(candidateVersion)) {
  refuse("VERSION is not a supported release version");
}

for (const path of FIXED_DATA_PATHS) {
  if (path.endsWith(".json") && changedPaths.includes(path)) {
    parseJson(show(candidateSha, path), path);
  }
}

let expectedLock = show(mainSha, "bun.lock");
for (const path of packagePaths.toSorted(compareCodeUnit)) {
  const before = parseJson(show(mainSha, path), path.concat(" on main"));
  const after = parseJson(
    show(candidateSha, path),
    path.concat(" on candidate"),
  );
  if (!isRecord(before) || !isRecord(after)) {
    refuse(path.concat(" must contain a JSON object"));
  }
  const beforeVersion = before.version;
  const afterVersion = after.version;
  const packageName = after.name;
  if (
    typeof beforeVersion !== "string" ||
    typeof afterVersion !== "string" ||
    typeof packageName !== "string" ||
    !VERSION_PATTERN.test(beforeVersion) ||
    !VERSION_PATTERN.test(afterVersion)
  ) {
    refuse(path.concat(" has an invalid package identity or version"));
  }
  const beforeWithoutVersion = { ...before };
  const afterWithoutVersion = { ...after };
  delete beforeWithoutVersion.version;
  delete afterWithoutVersion.version;
  if (
    JSON.stringify(beforeWithoutVersion) !== JSON.stringify(afterWithoutVersion)
  ) {
    refuse(path.concat(" changes fields other than version"));
  }

  const workspacePath = path.slice(0, -"/package.json".length);
  const oldBlock =
    `    ${JSON.stringify(workspacePath)}: {\n` +
    `      "name": ${JSON.stringify(packageName)},\n` +
    `      "version": ${JSON.stringify(beforeVersion)},`;
  const newBlock =
    `    ${JSON.stringify(workspacePath)}: {\n` +
    `      "name": ${JSON.stringify(packageName)},\n` +
    `      "version": ${JSON.stringify(afterVersion)},`;
  if (!expectedLock.includes(oldBlock)) {
    refuse(
      "bun.lock does not contain the main workspace entry for ".concat(path),
    );
  }
  expectedLock = expectedLock.replace(oldBlock, () => newBlock);
}

if (show(candidateSha, "bun.lock") !== expectedLock) {
  refuse(
    "bun.lock changes are not exactly the validated workspace version bumps",
  );
}
