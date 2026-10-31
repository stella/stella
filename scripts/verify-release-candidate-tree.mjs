#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const MAX_CHANGED_DATA_BYTES = 2 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:rc|beta|alpha)\.[0-9]+)?$/u;
const PACKAGE_JSON_PATTERN = /^packages\/[^/]+\/package\.json$/u;
const CLI_PACKAGE_PATH = "packages/cli/package.json";
const CLI_VERSION_PATH = "packages/cli/src/generated/cli-version.ts";
const DATA_PATH_PATTERNS = [
  /^\.changeset\/(?!README\.md$)[^/]+\.md$/u,
  /^docs\/changelog\/v[^/]+\.md$/u,
  /^packages\/[^/]+\/CHANGELOG\.md$/u,
];
const FIXED_DATA_PATHS = new Set([
  "VERSION",
  "apps/landing/public/media/products/recordings-manifest.json",
  "apps/landing/src/data/changelog-release-dates.json",
]);
// Generated files our own bots rewrite on the release branch. A class's paths
// pass only when every release-range commit touching the class is that bot's,
// committed by GitHub on its behalf, and the candidate holds exactly the bytes
// the bot's latest commit wrote. Their bytes have their own, larger bound.
const GENERATED_CLASSES = [
  {
    name: "Tailwind class cache",
    prefix: ".tailwind-cache/",
    authorEmail: "114827586+autofix-ci[bot]@users.noreply.github.com",
  },
  {
    name: "landing product media",
    prefix: "apps/landing/public/media/products/",
    authorEmail:
      "281031312+stella-release-deployer[bot]@users.noreply.github.com",
  },
];
const GENERATED_COMMITTER_EMAIL = "noreply@github.com";
const MAX_GENERATED_DATA_BYTES = 32 * 1024 * 1024;

/**
 * @param {string} message Refusal reason written to stderr.
 * @returns {never} This function always exits the process.
 */
const refuse = (message) => {
  process.stderr.write(`RELEASE_CANDIDATE_TREE_REFUSED: ${message}\n`);
  process.exit(1);
};

const givenMainSha = process.argv[2] ?? "";
const givenCandidateSha = process.argv[3] ?? "";
const repository = process.argv[4] ?? "";
if (!SHA_PATTERN.test(givenMainSha) || !SHA_PATTERN.test(givenCandidateSha)) {
  refuse("expected full lowercase main and candidate SHAs");
}
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const repositoryParts = REPOSITORY_PATTERN.exec(repository);
if (repositoryParts === null) {
  refuse("expected the owner/name repository as the third argument");
}
const RELEASE_PR_HEAD_FLAG = "--release-pr-head";
const releasePrHead = process.argv.length > 5 ? (process.argv[6] ?? "") : null;
if (
  releasePrHead !== null &&
  (process.argv.length !== 7 ||
    process.argv[5] !== RELEASE_PR_HEAD_FLAG ||
    !SHA_PATTERN.test(releasePrHead))
) {
  refuse(
    `expected only ${RELEASE_PR_HEAD_FLAG} <full SHA> after the repository`,
  );
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

/**
 * The range to verify. Main is squash-only, so a merged version commit carries
 * every release-branch commit under the merger's name. Given the merged release
 * pull request head, the version commit must hold exactly that head's tree, and
 * the range from the version commit's parent to the head is verified, where
 * each generated file still names the bot that wrote it.
 * @returns {[string, string]} Main and candidate commits of the verified range.
 */
const verifiedRange = () => {
  if (releasePrHead === null) {
    return [givenMainSha, givenCandidateSha];
  }
  const tree = (/** @type {string} */ sha) =>
    git("rev-parse", sha.concat("^{tree}")).trim();
  if (tree(givenCandidateSha) !== tree(releasePrHead)) {
    refuse(
      `version commit ${givenCandidateSha} does not hold the tree of its release pull request head ${releasePrHead}`,
    );
  }
  // The head must already contain the version commit's parent (checked below
  // as for any candidate): otherwise a squash holding the head's tree would
  // silently revert what main gained after the branch last merged it.
  return [givenMainSha, releasePrHead];
};
const [mainSha, candidateSha] = verifiedRange();

try {
  execFileSync("git", ["merge-base", "--is-ancestor", mainSha, candidateSha], {
    maxBuffer: 2 ** 30,
    stdio: "ignore",
  });
} catch {
  refuse("candidate does not contain the current main commit");
}

// Rename detection would list only the new path, hiding the deleted one
// from the allowlist.
const changedPaths = git(
  "diff",
  "--name-only",
  "--no-renames",
  "-z",
  mainSha.concat("..", candidateSha),
)
  .split("\0")
  .filter(Boolean);
if (!changedPaths.includes("VERSION")) {
  refuse("candidate does not change VERSION");
}

const packagePaths = /** @type {string[]} */ ([]);
const generatedPaths = new Map(
  GENERATED_CLASSES.map((generatedClass) => [
    generatedClass,
    /** @type {string[]} */ ([]),
  ]),
);
let changedDataBytes = 0;
let generatedDataBytes = 0;
for (const path of changedPaths) {
  const generatedClass = FIXED_DATA_PATHS.has(path)
    ? undefined
    : GENERATED_CLASSES.find(({ prefix }) => path.startsWith(prefix));
  if (generatedClass !== undefined) {
    if (path.includes("\n")) {
      refuse(`generated path has an unsupported name: ${JSON.stringify(path)}`);
    }
    generatedPaths.get(generatedClass)?.push(path);
  } else if (PACKAGE_JSON_PATTERN.test(path)) {
    packagePaths.push(path);
  } else if (
    path !== "bun.lock" &&
    path !== CLI_VERSION_PATH &&
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
  const bytes = Number(git("cat-file", "-s", candidateSha.concat(":", path)));
  if (generatedClass === undefined) {
    changedDataBytes += bytes;
  } else {
    generatedDataBytes += bytes;
  }
  if (
    !Number.isSafeInteger(changedDataBytes) ||
    changedDataBytes > MAX_CHANGED_DATA_BYTES
  ) {
    refuse("candidate release data exceeds the 2 MiB review bound");
  }
  if (
    !Number.isSafeInteger(generatedDataBytes) ||
    generatedDataBytes > MAX_GENERATED_DATA_BYTES
  ) {
    refuse("candidate generated files exceed the 32 MiB review bound");
  }
}

/**
 * Blob ids under a prefix at a commit, by path.
 * @param {string} sha Commit whose tree is listed.
 * @param {string} prefix Directory prefix, ending in a slash.
 * @returns {Map<string, string>} Blob id per path.
 */
const blobsUnder = (sha, prefix) =>
  new Map(
    git("ls-tree", "-r", "-z", sha, "--", prefix)
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [meta = "", path = ""] = entry.split("\t");
        return [path, meta.split(" ")[2] ?? ""];
      }),
  );

/** Commits whose GitHub signature each generated class depends on. */
const generatedCommits = new Map(/** @type {[string, string][]} */ ([]));

for (const [generatedClass, paths] of generatedPaths) {
  if (paths.length === 0) {
    continue;
  }
  const { name, prefix, authorEmail } = generatedClass;
  // Newest first; a path's first listing is the latest commit that wrote it.
  const latestCommitByPath = new Map(/** @type {[string, string][]} */ ([]));
  let commit = "";
  for (const line of git(
    "-c",
    "core.quotePath=false",
    "log",
    "--no-merges",
    "--no-renames",
    "--name-only",
    "--format=%x01%H%x02%ae%x02%ce",
    mainSha.concat("..", candidateSha),
    "--",
    prefix,
    // Fixed data under the prefix (the media manifest) is the release cut's
    // own output and is validated as data above, whoever wrote it.
    ...[...FIXED_DATA_PATHS]
      .filter((path) => path.startsWith(prefix))
      .map((path) => ":(exclude,literal)".concat(path)),
  ).split("\n")) {
    if (line.startsWith("\u0001")) {
      const [sha = "", author = "", committer = ""] = line
        .slice(1)
        .split("\u0002");
      if (author !== authorEmail || committer !== GENERATED_COMMITTER_EMAIL) {
        refuse(
          `${name} changed by a commit not made by its bot: ${sha} (${author})`,
        );
      }
      generatedCommits.set(sha, name);
      commit = sha;
    } else if (line.length > 0 && !latestCommitByPath.has(line)) {
      latestCommitByPath.set(line, commit);
    }
  }
  const candidateBlobs = blobsUnder(candidateSha, prefix);
  const commitBlobs = new Map(
    /** @type {[string, Map<string, string>][]} */ ([]),
  );
  for (const path of paths) {
    const latest =
      latestCommitByPath.get(path) ??
      refuse(`${name} path changed outside a bot commit: ${path}`);
    const written =
      commitBlobs.get(latest) ??
      commitBlobs.set(latest, blobsUnder(latest, prefix)).get(latest);
    if (written?.get(path) !== candidateBlobs.get(path)) {
      refuse(`${name} path differs from its bot's commit: ${path}`);
    }
  }
}

// Author and committer strings are free text in Git. GitHub's own record must
// show that it signed each bot commit as committer, on the bot's behalf.
const GITHUB_SIGNER = "web-flow";
const SIGNATURE_BATCH = 50;
const generatedShas = [...generatedCommits.keys()];
for (let start = 0; start < generatedShas.length; start += SIGNATURE_BATCH) {
  const batch = generatedShas.slice(start, start + SIGNATURE_BATCH);
  const fields = batch
    .map(
      (sha, index) =>
        `c${index}: object(oid: "${sha}") { ... on Commit { oid signature { isValid state wasSignedByGitHub signer { login } } } }`,
    )
    .join(" ");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const command = process.env.GH_RETRY_SCRIPT ? "bash" : "gh";
  const args = [
    ...(process.env.GH_RETRY_SCRIPT ? [process.env.GH_RETRY_SCRIPT] : []),
    "api",
    "graphql",
    "-f",
    "query=".concat(query),
    "-F",
    "owner=".concat(repositoryParts[1] ?? ""),
    "-F",
    "name=".concat(repositoryParts[2] ?? ""),
  ];
  let response = "";
  try {
    response = execFileSync(command, args, {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    refuse("could not read GitHub's signature record for generated files");
  }
  const parsed = parseJson(response, "GitHub signature response");
  const objects =
    isRecord(parsed) &&
    isRecord(parsed.data) &&
    isRecord(parsed.data.repository)
      ? parsed.data.repository
      : refuse("GitHub signature response has no repository");
  for (const [index, sha] of batch.entries()) {
    const object = objects[`c${index}`];
    const signature = isRecord(object) ? object.signature : undefined;
    const signer = isRecord(signature) ? signature.signer : undefined;
    if (
      !isRecord(object) ||
      object.oid !== sha ||
      !isRecord(signature) ||
      signature.isValid !== true ||
      signature.state !== "VALID" ||
      signature.wasSignedByGitHub !== true ||
      !isRecord(signer) ||
      signer.login !== GITHUB_SIGNER
    ) {
      refuse(
        `${generatedCommits.get(sha) ?? "generated file"} commit is not signed by GitHub for its bot: ${sha}`,
      );
    }
  }
}

const candidateVersion = show(candidateSha, "VERSION").trim();
if (!VERSION_PATTERN.test(candidateVersion)) {
  refuse("VERSION is not a supported release version");
}

for (const path of FIXED_DATA_PATHS) {
  if (path.endsWith(".json") && changedPaths.includes(path)) {
    const value = parseJson(show(candidateSha, path), path);
    if (
      path === "apps/landing/src/data/changelog-release-dates.json" &&
      (!isRecord(value) ||
        Object.values(value).some(
          (date) => date !== null && typeof date !== "string",
        ))
    ) {
      refuse(`${path} must map release names to timestamps or null`);
    }
  }
}

let expectedLock = show(mainSha, "bun.lock");
const versionBumps = new Map(
  /** @type {[string, { before: string; after: string }][]} */ ([]),
);
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
  versionBumps.set(path, { before: beforeVersion, after: afterVersion });

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

// `changeset:version` regenerates the CLI's baked version; the only accepted
// change is main's file with the version literal swapped for the bump.
if (changedPaths.includes(CLI_VERSION_PATH)) {
  const bump =
    versionBumps.get(CLI_PACKAGE_PATH) ??
    refuse(CLI_VERSION_PATH.concat(" changed without a CLI version bump"));
  const literal = (/** @type {string} */ version) =>
    `export const CLI_VERSION = ${JSON.stringify(version)};`;
  const onMain = show(mainSha, CLI_VERSION_PATH);
  if (
    !onMain.includes(literal(bump.before)) ||
    show(candidateSha, CLI_VERSION_PATH) !==
      onMain.replace(literal(bump.before), () => literal(bump.after))
  ) {
    refuse(CLI_VERSION_PATH.concat(" changes more than the CLI version"));
  }
}
