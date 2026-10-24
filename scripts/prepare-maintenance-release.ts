#!/usr/bin/env bun

import { Result } from "better-result";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

import { RECORDINGS_MANIFEST_PATH } from "../apps/web/e2e/marketing/captures";
import { parseChangesetEntry } from "./changeset-entry";
import { computeProvenanceVerdicts } from "./check-marketing-recordings";
import { releaseQueueHistoryWarning } from "./check-release-queue-history";
import {
  commandGateFailureReason,
  MAINTENANCE_CUT_GATES,
  postCutGates,
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";

// Computed filesystem reads retain these repository Markdown inputs.
export const CI_MARKDOWN_READER_INPUTS = [
  ".changeset/*.md",
  "docs/changelog/*.md",
  "packages/*/CHANGELOG.md",
];

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const RELEASE_DATES_PATH = "apps/landing/src/data/changelog-release-dates.json";
const CONFIRMATION_FLAG = "--confirm-current-recordings-reviewed";
const REASON_FLAG = "--reason";
// Cuts from a commit whose main/heavy or main/pr-depth is not green. The cut
// still prints every red or missing gate, so the override stays on record.
const ALLOW_UNPROVEN_MAIN_FLAG = "--allow-unproven-main";
// A bare `bun run release:maintenance` carries stale recordings forward under
// this standing attestation instead of stopping the release. Pass
// CONFIRMATION_FLAG with REASON_FLAG to record a specific review instead.
const DEFAULT_REVIEW_REASON = "Patch release, UX diff negligible";
const GITHUB_API_ROOT = "https://api.github.com/repos/stella/stella";
const RELEASE_PAGE_SIZE = 100;
const RELEASE_PAGE_LIMIT = 20;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
// A summary line that opens a block the landing renderer cannot show: indented
// code, a heading, quote or table row, a list item, or a code fence.
const BLOCK_MARKUP_LINE =
  /^(?: {4}|\t|[^\S\r\n]*(?:[#>|]|[-*+]\s|\d+[.)]\s|`{3}|~{3}))/u;
const MAINTENANCE_CHANGELOG =
  "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n";
const PACKAGES_HEADING = "## Packages";
const CHANGESET_DIRECTORY = ".changeset";
/** Declares which files a version run generates; the CI gate reads the same. */
const CHANGESET_POLICY_PATH = "scripts/changeset-policy.json";
/** Changesets ships this file; it is documentation, never a release entry. */
const CHANGESET_README = "README.md";
/**
 * The release commit carries the generated version bumps, which are
 * release-gated paths. The changeset policy asks for an added entry beside
 * them; the bump is generated rather than a change of its own, so the entry
 * that accompanies it is empty. The next release's fold consumes it.
 */
const EMPTY_CHANGESET = "---\n---\n";

type StableVersion = {
  major: number;
  minor: number;
  patch: number;
  value: string;
};

/**
 * What GitHub knows about the release VERSION names. A version commit that was
 * never tagged is superseded by the next one: it is not a release, so it gets
 * no publication record and no page of its own. Its notes fold into the next
 * release's changelog, and its changelog file is removed.
 */
export type PreviousRelease =
  | { kind: "published"; publishedAt: string }
  | { kind: "unpromoted" }
  | { kind: "superseded" };

const PREVIOUS_RELEASE_NOTE: Record<PreviousRelease["kind"], string> = {
  published: "",
  superseded: ": never tagged, superseded, not recorded",
  unpromoted: ": never promoted",
};

type MaintenanceReleaseOptions = {
  allowUnprovenMain: boolean;
  recordingReviewReason: string;
};

type PreparedMaintenanceRelease = {
  changelogPath: string;
  /** Names of the `.changeset` entries this run consumed, in read order. */
  changesets: readonly string[];
  /**
   * The superseded version's changelog this run folded into the release and
   * removed; null when the previous version was tagged.
   */
  foldedChangelogPath: string | null;
  previousTag: string;
  version: string;
};

/** One pending `.changeset/*.md` entry. */
type PendingChangeset = {
  readonly file: string;
  readonly packages: readonly string[];
  readonly summary: string;
};

type ReleaseFileWriter = (path: string, contents: string) => void;

type FileSnapshot = {
  contents: string | null;
  path: string;
};

export class MaintenanceReleaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaintenanceReleaseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const checkedVersionPart = (value: string | undefined): number => {
  if (value === undefined) {
    throw new MaintenanceReleaseError("Missing stable version part");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MaintenanceReleaseError(`Invalid stable version part: ${value}`);
  }
  return parsed;
};

export const readPendingChangesets = (
  rootDir: string,
): readonly PendingChangeset[] => {
  const directory = nodePath.join(rootDir, CHANGESET_DIRECTORY);
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md") && file !== CHANGESET_README)
    .toSorted()
    .map((file) => {
      const { packages, summary } = parseChangesetEntry(
        readFileSync(nodePath.join(directory, file), "utf-8"),
      );
      return { file, packages, summary };
    });
};

/**
 * Every file a version run rewrites: the generated paths the release policy
 * declares, plus the entries the run consumes. Read from the policy rather
 * than listed here, so a package added to the release set is covered without
 * this script being told about it.
 */
const versionRollbackPaths = (
  rootDir: string,
  changesets: readonly PendingChangeset[],
): readonly string[] => {
  if (changesets.length === 0) {
    return [];
  }
  const policyPath = nodePath.join(rootDir, CHANGESET_POLICY_PATH);
  const parsed: unknown = JSON.parse(readFileSync(policyPath, "utf-8"));
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed["generatedPaths"]) ||
    !parsed["generatedPaths"].every((entry) => typeof entry === "string")
  ) {
    throw new MaintenanceReleaseError(
      `${CHANGESET_POLICY_PATH} must hold generatedPaths as an array of strings`,
    );
  }
  const generated: readonly string[] = parsed["generatedPaths"];
  return [
    ...generated.map((file) => nodePath.join(rootDir, file)),
    ...changesets.map(({ file }) =>
      nodePath.join(rootDir, CHANGESET_DIRECTORY, file),
    ),
  ];
};

/**
 * The release note the landing changelog and the GitHub release read. The
 * standing maintenance text stays first, so a release that folds nothing in
 * reads exactly as it did before.
 */
export const maintenanceChangelog = (
  changesets: readonly PendingChangeset[],
  version: string,
): string => {
  const released = changesets.filter(({ packages }) => packages.length > 0);
  if (released.length === 0) {
    return MAINTENANCE_CHANGELOG;
  }
  const entries = released
    .map(({ packages, summary }) => {
      const links = packages.map((name) => {
        // Workspace names are @stll/<directory>; do not emit a broken link
        // for a frontmatter name outside that repository contract.
        if (!/^@stll\/[a-z0-9-]+$/u.test(name)) {
          throw new MaintenanceReleaseError(`Invalid package name: ${name}`);
        }
        const directory = name.slice("@stll/".length);
        return `[${name}](https://github.com/stella/stella/blob/v${version}/packages/${directory}/CHANGELOG.md)`;
      });
      const paragraph = summary.split(/\r?\n[^\S\r\n]*\r?\n/u).at(0) ?? "";
      // The landing renderer supports flat bullets, not tables, code blocks
      // or nested lists. Block-first notes stay in the linked changelog.
      const hasBlockMarkup =
        paragraph.includes("|") ||
        paragraph.split(/\r?\n/u).some((line) => BLOCK_MARKUP_LINE.test(line));
      const excerpt =
        paragraph && !hasBlockMarkup
          ? paragraph.replaceAll(/\s+/gu, " ").trim()
          : "See package changelog for details.";
      return `- ${links.join(", ")}: ${excerpt}\n`;
    })
    .join("");
  return `${MAINTENANCE_CHANGELOG}\n${PACKAGES_HEADING}\n\n${entries}`;
};

type ChangelogSections = {
  /** Everything before the packages section, ending in one newline. */
  body: string;
  /** The packages section's bullets, one line each, without newlines. */
  entries: readonly string[];
};

/**
 * Splits a changelog note at its packages section. The section holds only the
 * one-line bullets `maintenanceChangelog` writes; anything else under it is a
 * hand edit this fold cannot place, so it fails rather than reorder it.
 */
const splitChangelog = (markdown: string, name: string): ChangelogSections => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headingIndex = lines.findIndex(
    (line) => line.trimEnd() === PACKAGES_HEADING,
  );
  const bodyLines = headingIndex === -1 ? lines : lines.slice(0, headingIndex);
  const entries =
    headingIndex === -1
      ? []
      : lines.slice(headingIndex + 1).filter((line) => line.trim() !== "");
  const unplaced = entries.find((line) => !line.startsWith("- "));
  if (unplaced !== undefined) {
    throw new MaintenanceReleaseError(
      `The ${name} changelog holds a line the release cannot fold under ${PACKAGES_HEADING}: ${unplaced}`,
    );
  }
  return { body: `${bodyLines.join("\n").trimEnd()}\n`, entries };
};

/**
 * The release note of a cut that supersedes a version never tagged. That
 * version is not a release, so it keeps no page: its notes become this
 * release's. A superseded note that shows a change keeps its heading and
 * media, which the release guard then requires of this release; a maintenance
 * note stays the maintenance note it is. Package bullets of both follow,
 * oldest first, with links moved to this release's tag, since the superseded
 * tag does not exist. Folding is transitive: a superseded note already holds
 * the notes it superseded.
 */
export const foldSupersededChangelog = ({
  next,
  superseded,
  supersededVersion,
  version,
}: {
  /** The note this cut writes on its own, from `maintenanceChangelog`. */
  next: string;
  superseded: string;
  supersededVersion: string;
  version: string;
}): string => {
  const retagged = superseded.replaceAll(
    `https://github.com/stella/stella/blob/v${supersededVersion}/`,
    () => `https://github.com/stella/stella/blob/v${version}/`,
  );
  const older = splitChangelog(retagged, `v${supersededVersion}`);
  const newer = splitChangelog(next, `v${version}`);
  const entries = [...new Set([...older.entries, ...newer.entries])];
  if (entries.length === 0) {
    return older.body;
  }
  return `${older.body}\n${PACKAGES_HEADING}\n\n${entries.map((entry) => `${entry}\n`).join("")}`;
};

export const parseStableVersion = (value: string): StableVersion => {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new MaintenanceReleaseError(
      `VERSION must be a stable semantic version; got '${value}'`,
    );
  }
  return {
    major: checkedVersionPart(match.at(1)),
    minor: checkedVersionPart(match.at(2)),
    patch: checkedVersionPart(match.at(3)),
    value,
  };
};

export const nextPatchVersion = (current: StableVersion): StableVersion => {
  const patch = current.patch + 1;
  if (!Number.isSafeInteger(patch)) {
    throw new MaintenanceReleaseError(
      `Patch version cannot be incremented safely: ${current.value}`,
    );
  }
  return {
    major: current.major,
    minor: current.minor,
    patch,
    value: `${String(current.major)}.${String(current.minor)}.${String(patch)}`,
  };
};

export const parseMaintenanceReleaseOptions = (
  args: readonly string[],
): MaintenanceReleaseOptions => {
  let confirmed = false;
  let allowUnprovenMain = false;
  let reason: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args.at(index);
    if (
      flag !== CONFIRMATION_FLAG &&
      flag !== REASON_FLAG &&
      flag !== ALLOW_UNPROVEN_MAIN_FLAG
    ) {
      throw new MaintenanceReleaseError(`Unknown argument: ${String(flag)}`);
    }
    if (seen.has(flag)) {
      throw new MaintenanceReleaseError(`${flag} may be passed only once`);
    }
    seen.add(flag);

    if (flag === ALLOW_UNPROVEN_MAIN_FLAG) {
      allowUnprovenMain = true;
      continue;
    }
    if (flag === CONFIRMATION_FLAG) {
      confirmed = true;
      continue;
    }
    const value = args.at(index + 1);
    if (!value || value.startsWith("--")) {
      throw new MaintenanceReleaseError(`${REASON_FLAG} requires a value`);
    }
    reason = value;
    index += 1;
  }

  if (!confirmed && reason === undefined) {
    return { allowUnprovenMain, recordingReviewReason: DEFAULT_REVIEW_REASON };
  }
  if (!confirmed) {
    throw new MaintenanceReleaseError(
      `${REASON_FLAG} requires ${CONFIRMATION_FLAG}`,
    );
  }
  if (
    !reason ||
    reason.trim() !== reason ||
    reason.length < 12 ||
    reason.length > 240
  ) {
    throw new MaintenanceReleaseError(
      `${REASON_FLAG} must be a trimmed reason between 12 and 240 characters`,
    );
  }
  return { allowUnprovenMain, recordingReviewReason: reason };
};

// A `null` value records a stable tag that was built but never promoted; the
// landing changelog omits it. Preserved as written: a maintenance release
// after an unpromoted one must not turn that record into a publication date.
const readReleaseDates = (rootDir: string): Record<string, string | null> => {
  const parsed: unknown = JSON.parse(
    readFileSync(nodePath.join(rootDir, RELEASE_DATES_PATH), "utf-8"),
  );
  if (
    !isRecord(parsed) ||
    Object.values(parsed).some(
      (value) => typeof value !== "string" && value !== null,
    )
  ) {
    throw new MaintenanceReleaseError(
      `${RELEASE_DATES_PATH} must be an object of string or null values`,
    );
  }
  const releaseDates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" || value === null) {
      releaseDates[key] = value;
    }
  }
  return releaseDates;
};

const atomicWriteFile: ReleaseFileWriter = (path, contents) => {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

export const withFileRollback = <T>({
  operation,
  paths,
  writeFile = atomicWriteFile,
}: {
  operation: () => T;
  paths: readonly string[];
  writeFile?: ReleaseFileWriter;
}): T => {
  const snapshots: FileSnapshot[] = paths.map((path) => ({
    contents: existsSync(path) ? readFileSync(path, "utf-8") : null,
    path,
  }));
  try {
    return operation();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const { contents, path } of snapshots) {
      try {
        if (contents === null) {
          rmSync(path, { force: true });
        } else {
          writeFile(path, contents);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      const originalMessage =
        error instanceof Error ? error.message : String(error);
      throw new MaintenanceReleaseError(
        `Release preparation failed (${originalMessage}) and ${String(rollbackErrors.length)} rollback operation(s) did not complete: ${rollbackErrors.map(String).join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * `changeset version` as the organization's version pull request runs it: the
 * repository's own script, so both flows bump versions, write package
 * changelogs and delete consumed entries the same way.
 */
const runChangesetVersion = (rootDir: string) => {
  const result = Bun.spawnSync(["bun", "run", "changeset:version"], {
    cwd: rootDir,
    env: changesetVersionEnv(process.env, githubToken()),
    stderr: "inherit",
    stdout: "inherit",
  });
  if (!result.success) {
    throw new MaintenanceReleaseError(
      `bun run changeset:version exited with code ${String(result.exitCode)}`,
    );
  }
};

export const prepareMaintenanceReleaseFiles = ({
  previousRelease,
  rootDir,
  versionPackages = runChangesetVersion,
  writeFile = atomicWriteFile,
}: {
  previousRelease: PreviousRelease;
  rootDir: string;
  /** Consumes the pending changesets; the repository's own version script. */
  versionPackages?: (rootDir: string) => void;
  writeFile?: ReleaseFileWriter;
}): PreparedMaintenanceRelease => {
  if (
    previousRelease.kind === "published" &&
    Number.isNaN(Date.parse(previousRelease.publishedAt))
  ) {
    throw new MaintenanceReleaseError(
      `Previous release has an invalid publication timestamp: ${previousRelease.publishedAt}`,
    );
  }

  const versionPath = nodePath.join(rootDir, "VERSION");
  const current = parseStableVersion(readFileSync(versionPath, "utf-8").trim());
  const next = nextPatchVersion(current);
  const previousTag = `v${current.value}`;
  const previousChangelogPath = `docs/changelog/${previousTag}.md`;
  const absolutePreviousChangelogPath = nodePath.join(
    rootDir,
    previousChangelogPath,
  );
  if (!existsSync(absolutePreviousChangelogPath)) {
    throw new MaintenanceReleaseError(
      `Previous release changelog is missing: ${previousChangelogPath}`,
    );
  }
  const supersededChangelog =
    previousRelease.kind === "superseded"
      ? readFileSync(absolutePreviousChangelogPath, "utf-8")
      : null;

  const changelogPath = `docs/changelog/v${next.value}.md`;
  const absoluteChangelogPath = nodePath.join(rootDir, changelogPath);
  if (existsSync(absoluteChangelogPath)) {
    throw new MaintenanceReleaseError(
      `Next release changelog already exists: ${changelogPath}`,
    );
  }

  const releaseDatesPath = nodePath.join(rootDir, RELEASE_DATES_PATH);
  const releaseDates = readReleaseDates(rootDir);
  if (
    previousRelease.kind !== "superseded" &&
    releaseDates[previousTag] !== null
  ) {
    releaseDates[previousTag] =
      previousRelease.kind === "published" ? previousRelease.publishedAt : null;
  }
  const changesets = readPendingChangesets(rootDir);
  const emptyChangesetPath = nodePath.join(
    rootDir,
    CHANGESET_DIRECTORY,
    `release-v${next.value}.md`,
  );
  return withFileRollback({
    operation: () => {
      if (changesets.length > 0) {
        // Package versions, package changelogs and the consumed entries are
        // whatever the version script produces, so the release carries the
        // same bytes the version pull request would have. Those writes are
        // the one part of this preparation the rollback below cannot
        // restore; the run starts from a clean worktree, so a checkout does.
        versionPackages(rootDir);
        writeFile(emptyChangesetPath, EMPTY_CHANGESET);
      }
      // VERSION is the commit marker: every dependent file is durable before
      // it advances. Atomic sibling renames prevent truncated files.
      const changelog = maintenanceChangelog(changesets, next.value);
      writeFile(
        absoluteChangelogPath,
        supersededChangelog === null
          ? changelog
          : foldSupersededChangelog({
              next: changelog,
              superseded: supersededChangelog,
              supersededVersion: current.value,
              version: next.value,
            }),
      );
      // A version that was never tagged publishes no page: its notes now
      // live in this release's, and the landing changelog lists every file.
      if (supersededChangelog !== null) {
        rmSync(absolutePreviousChangelogPath);
      }
      writeFile(releaseDatesPath, `${JSON.stringify(releaseDates, null, 2)}\n`);
      writeFile(versionPath, `${next.value}\n`);
      return {
        changelogPath,
        changesets: changesets.map(({ file }) => file),
        foldedChangelogPath:
          supersededChangelog === null ? null : previousChangelogPath,
        previousTag,
        version: next.value,
      };
    },
    paths: [
      versionPath,
      releaseDatesPath,
      absoluteChangelogPath,
      absolutePreviousChangelogPath,
      emptyChangesetPath,
      ...versionRollbackPaths(rootDir, changesets),
    ],
    writeFile,
  });
};

export type RefreshedMaintenanceRelease = {
  changelogPath: string;
  /** Names of the `.changeset` entries this refresh consumed, in read order. */
  changesets: readonly string[];
  version: string;
};

/**
 * Consumes changesets that reached main after this release was cut, on the
 * release branch once main is merged into it. The version stays; the new
 * entries are versioned as the cut versioned its own, and their bullets join
 * this release's note. Without it a `@stll/cli` entry that lands after the cut
 * stays pending, and the tag refuses the release. Returns null when nothing is
 * pending beyond the cut's own marker entry.
 */
export const refreshMaintenanceReleaseFiles = ({
  rootDir,
  versionPackages = runChangesetVersion,
  writeFile = atomicWriteFile,
}: {
  rootDir: string;
  versionPackages?: (rootDir: string) => void;
  writeFile?: ReleaseFileWriter;
}): RefreshedMaintenanceRelease | null => {
  const version = parseStableVersion(
    readFileSync(nodePath.join(rootDir, "VERSION"), "utf-8").trim(),
  ).value;
  const markerFile = `release-v${version}.md`;
  const markerPath = nodePath.join(rootDir, CHANGESET_DIRECTORY, markerFile);
  if (!existsSync(markerPath)) {
    throw new MaintenanceReleaseError(
      `No cut release v${version} to refresh: ${CHANGESET_DIRECTORY}/${markerFile} is missing`,
    );
  }
  const changelogPath = `docs/changelog/v${version}.md`;
  const absoluteChangelogPath = nodePath.join(rootDir, changelogPath);
  if (!existsSync(absoluteChangelogPath)) {
    throw new MaintenanceReleaseError(
      `Release changelog is missing: ${changelogPath}`,
    );
  }
  const changesets = readPendingChangesets(rootDir).filter(
    ({ file }) => file !== markerFile,
  );
  if (changesets.length === 0) {
    return null;
  }
  return withFileRollback({
    operation: () => {
      // The version script consumes every pending entry, the cut's marker
      // included; the marker is the release policy's added entry, so it is
      // written back.
      versionPackages(rootDir);
      writeFile(markerPath, EMPTY_CHANGESET);
      const current = splitChangelog(
        readFileSync(absoluteChangelogPath, "utf-8"),
        `v${version}`,
      );
      const added = splitChangelog(
        maintenanceChangelog(changesets, version),
        `v${version}`,
      );
      const entries = [...new Set([...current.entries, ...added.entries])];
      writeFile(
        absoluteChangelogPath,
        entries.length === 0
          ? current.body
          : `${current.body}\n${PACKAGES_HEADING}\n\n${entries.map((entry) => `${entry}\n`).join("")}`,
      );
      return {
        changelogPath,
        changesets: changesets.map(({ file }) => file),
        version,
      };
    },
    paths: [
      markerPath,
      absoluteChangelogPath,
      ...versionRollbackPaths(rootDir, changesets),
    ],
    writeFile,
  });
};

const REFRESH_FLAG = "--refresh";

const run = (command: readonly string[]) => {
  const result = Bun.spawnSync([...command], {
    cwd: ROOT_DIR,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (!result.success) {
    throw new MaintenanceReleaseError(
      `${command.join(" ")} exited with code ${String(result.exitCode)}`,
    );
  }
};

const assertCleanWorktree = (rootDir: string) => {
  const result = Bun.spawnSync(
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: rootDir, stderr: "pipe", stdout: "pipe" },
  );
  if (!result.success || result.stdout.length > 0) {
    throw new MaintenanceReleaseError(
      "Commit or stash worktree changes before preparing a release",
    );
  }
};

/** Runs a command and returns its stdout; null when it does not run. */
export type CommandOutput = (command: readonly string[]) => string | null;

const nonEmptyToken = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.length === 0 ? null : value;

// The reads go to github.com, so the token has to be that host's. A bare
// `gh auth token` answers for the CLI's default host, which is an Enterprise
// instance wherever the operator's GH_HOST points at one.
const GH_TOKEN_COMMAND = [
  "gh",
  "auth",
  "token",
  "--hostname",
  "github.com",
] as const;

// `gh` may be absent, or present and signed out of github.com. Both mean the
// same thing here: no token, and the reads below go out unauthenticated.
const spawnOutput: CommandOutput = (command) => {
  const spawned = Result.try(() =>
    Bun.spawnSync([...command], {
      cwd: ROOT_DIR,
      stderr: "pipe",
      stdout: "pipe",
    }),
  );
  return Result.isError(spawned) || !spawned.value.success
    ? null
    : spawned.value.stdout.toString();
};

/**
 * Token the GitHub reads are made with.
 *
 * The variables come first, since a workflow sets them. The signed-in CLI
 * stands behind them so a local run is not left to the anonymous rate limit,
 * which answers a release preparation with HTTP 403.
 */
export const resolveGitHubToken = (
  env: Record<string, string | undefined>,
  runCommand: CommandOutput = spawnOutput,
): string | null =>
  nonEmptyToken(env["GH_TOKEN"]) ??
  nonEmptyToken(env["GITHUB_TOKEN"]) ??
  nonEmptyToken(runCommand(GH_TOKEN_COMMAND)?.trim());

// Resolved once: one preparation makes a page of reads, and asking the CLI
// per read would spawn it as many times.
let resolvedToken: string | null | undefined;

const githubToken = (): string | null => {
  if (resolvedToken === undefined) {
    resolvedToken = resolveGitHubToken(process.env);
  }
  return resolvedToken;
};

/**
 * Environment for the nested version run. Changesets reads `GITHUB_TOKEN`
 * alone, so the token this script resolved for its own reads is passed under
 * that name; a run that took its token from `GH_TOKEN` or the signed-in CLI
 * would otherwise meet the changesets "create a GitHub personal access token"
 * failure. Every other variable stays the parent's, and a run with no token
 * inherits the environment unchanged.
 */
export const changesetVersionEnv = (
  env: Record<string, string | undefined>,
  token: string | null,
): Record<string, string | undefined> =>
  token === null ? env : { ...env, GITHUB_TOKEN: token };

const requestGitHub = async (path: string): Promise<Response> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "stella-maintenance-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(`${GITHUB_API_ROOT}${path}`, { headers });
};

const readPublishedAt = (tag: string, payload: unknown): PreviousRelease => {
  if (!isRecord(payload)) {
    throw new MaintenanceReleaseError(
      `GitHub release ${tag} has no valid published_at timestamp`,
    );
  }
  const publishedAt = payload["published_at"];
  if (publishedAt === null || publishedAt === undefined) {
    return { kind: "unpromoted" };
  }
  if (
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    throw new MaintenanceReleaseError(
      `GitHub release ${tag} has no valid published_at timestamp`,
    );
  }
  return { kind: "published", publishedAt };
};

const tagExists = async (tag: string): Promise<boolean> => {
  const response = await requestGitHub(
    `/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new MaintenanceReleaseError(
      `Could not read tag ${tag} from GitHub (HTTP ${String(response.status)})`,
    );
  }
  return true;
};

// The by-tag endpoint hides drafts, so its 404 is ambiguous. The full listing
// includes drafts for an authenticated caller and separates the two cases: a
// draft release is abandoned, no release object at all is unfinished.
const findUnpromotedRelease = async (
  tag: string,
  page: number,
): Promise<PreviousRelease> => {
  if (page > RELEASE_PAGE_LIMIT) {
    throw new MaintenanceReleaseError(
      `Could not find ${tag} in the ${String(RELEASE_PAGE_LIMIT * RELEASE_PAGE_SIZE)} most recent GitHub Releases`,
    );
  }
  const response = await requestGitHub(
    `/releases?per_page=${String(RELEASE_PAGE_SIZE)}&page=${String(page)}`,
  );
  if (!response.ok) {
    throw new MaintenanceReleaseError(
      `Could not list GitHub Releases (HTTP ${String(response.status)})`,
    );
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new MaintenanceReleaseError(
      "GitHub Releases returned an unexpected payload",
    );
  }
  const entries: unknown[] = payload;
  const release = entries.find(
    (entry) => isRecord(entry) && entry["tag_name"] === tag,
  );
  if (isRecord(release)) {
    return release["draft"] === true
      ? { kind: "unpromoted" }
      : readPublishedAt(tag, release);
  }
  if (entries.length < RELEASE_PAGE_SIZE) {
    throw new MaintenanceReleaseError(
      `Previous tag ${tag} has no GitHub release yet; wait for the release workflow to publish one`,
    );
  }
  return findUnpromotedRelease(tag, page + 1);
};

// Unpromoted means the tag was built but never promoted: the release is a
// draft, or it exists without a publication date. A tag whose release was
// never created is unfinished rather than abandoned, and fails the cut
// instead: a `null` written for it would never be replaced. No tag at all
// means the version commit was never tagged; this release supersedes it.
export const readPreviousRelease = async (
  tag: string,
): Promise<PreviousRelease> => {
  const response = await requestGitHub(
    `/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (response.ok) {
    return readPublishedAt(tag, await response.json());
  }
  if (response.status !== 404) {
    throw new MaintenanceReleaseError(
      `Could not read ${tag} from GitHub Releases (HTTP ${String(response.status)})`,
    );
  }
  if (!(await tagExists(tag))) {
    return { kind: "superseded" };
  }
  return findUnpromotedRelease(tag, 1);
};

/** Reads one GitHub REST path under the repository; throws when unreadable. */
export type GitHubJsonReader = (path: string) => Promise<unknown>;

const readGitHubJson: GitHubJsonReader = async (path) => {
  const response = await requestGitHub(path);
  if (!response.ok) {
    throw new MaintenanceReleaseError(
      `Could not read ${path} from GitHub (HTTP ${String(response.status)})`,
    );
  }
  const payload: unknown = await response.json();
  return payload;
};

const GITHUB_PAGE_SIZE = 100;
const GITHUB_PAGE_LIMIT = 10;
const TRUSTED_STATUS_CREATOR = "github-actions[bot]";
const RUN_URL_PREFIX = "https://github.com/stella/stella/actions/runs/";
// A job that ended any other way than these did not pass.
const PASSING_JOB_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

type ReleaseCutGateSpec = {
  context: "main/heavy" | "main/pr-depth";
  workflow: string;
  // main/pr-depth publishes no status when a scheduled run reused a completed
  // release proof; that run's own conclusion answers for the commit.
  scheduledRunFallback: boolean;
};

const RELEASE_CUT_GATES: readonly ReleaseCutGateSpec[] = [
  {
    context: "main/heavy",
    workflow: "main-heavy.yml",
    scheduledRunFallback: false,
  },
  {
    context: "main/pr-depth",
    workflow: "main-pr-depth.yml",
    scheduledRunFallback: true,
  },
];

export type ReleaseCutGate = {
  context: ReleaseCutGateSpec["context"];
  workflow: string;
  state: "success" | "failure" | "pending" | "missing" | "unreadable";
  /** What the verdict rests on, for the printed line. */
  evidence: string;
  runUrl: string | null;
  failingJobs: readonly string[];
};

const readGitHubPages = async (
  path: string,
  readJson: GitHubJsonReader,
  itemsOf: (payload: unknown) => unknown,
): Promise<unknown[]> => {
  const items: unknown[] = [];
  for (let page = 1; page <= GITHUB_PAGE_LIMIT; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = itemsOf(
      await readJson(
        `${path}${separator}per_page=${String(GITHUB_PAGE_SIZE)}&page=${String(page)}`,
      ),
    );
    if (!Array.isArray(payload)) {
      throw new MaintenanceReleaseError(
        `GitHub ${path} returned an unexpected payload`,
      );
    }
    const entries: unknown[] = payload;
    items.push(...entries);
    if (entries.length < GITHUB_PAGE_SIZE) {
      return items;
    }
  }
  throw new MaintenanceReleaseError(
    `GitHub ${path} exceeds ${String(GITHUB_PAGE_LIMIT)} pages of ${String(GITHUB_PAGE_SIZE)}`,
  );
};

const runIdFromUrl = (url: unknown): string | null => {
  if (typeof url !== "string" || !url.startsWith(RUN_URL_PREFIX)) {
    return null;
  }
  const id = url.slice(RUN_URL_PREFIX.length);
  return /^[1-9]\d*$/u.test(id) ? id : null;
};

const failingJobNames = async (
  runUrl: string | null,
  readJson: GitHubJsonReader,
): Promise<string[]> => {
  const runId = runIdFromUrl(runUrl);
  if (runId === null) {
    return [`(no workflow run linked: ${String(runUrl)})`];
  }
  const jobsResult = await Result.tryPromise(async () =>
    readGitHubPages(
      `/actions/runs/${runId}/jobs?filter=latest`,
      readJson,
      (payload) => (isRecord(payload) ? payload["jobs"] : undefined),
    ),
  );
  if (Result.isError(jobsResult)) {
    const { cause } = jobsResult.error;
    return [
      `(jobs unreadable: ${cause instanceof Error ? cause.message : String(cause)})`,
    ];
  }
  return jobsResult.value.flatMap((job) => {
    const name = isRecord(job) ? job["name"] : undefined;
    if (!isRecord(job) || typeof name !== "string") {
      return ["(a job GitHub returned without a name)"];
    }
    const conclusion = job["conclusion"];
    if (typeof conclusion === "string") {
      return PASSING_JOB_CONCLUSIONS.has(conclusion)
        ? []
        : [`${name} (${conclusion})`];
    }
    // Still queued or running: not a failure yet, but not a pass either.
    return [`${name} (${String(job["status"])})`];
  });
};

const STATUS_STATES: Record<string, ReleaseCutGate["state"]> = {
  error: "failure",
  failure: "failure",
  pending: "pending",
  success: "success",
};

const gateFromStatus = async (
  spec: ReleaseCutGateSpec,
  status: Record<string, unknown>,
  readJson: GitHubJsonReader,
): Promise<ReleaseCutGate> => {
  const creator = status["creator"];
  const login = isRecord(creator) ? creator["login"] : undefined;
  const runUrl =
    typeof status["target_url"] === "string" ? status["target_url"] : null;
  const reported = STATUS_STATES[String(status["state"])];
  // Only the workflow's own bot reports these contexts; anyone else's
  // success is no proof.
  const state =
    login === TRUSTED_STATUS_CREATOR ? (reported ?? "unreadable") : "failure";
  const evidence =
    login === TRUSTED_STATUS_CREATOR
      ? `status ${String(status["state"])}`
      : `status ${String(status["state"])} set by ${String(login)}, not ${TRUSTED_STATUS_CREATOR}`;
  return {
    context: spec.context,
    workflow: spec.workflow,
    state,
    evidence,
    runUrl,
    failingJobs:
      state === "success" ? [] : await failingJobNames(runUrl, readJson),
  };
};

const gateFromScheduledRun = async (
  spec: ReleaseCutGateSpec,
  sha: string,
  readJson: GitHubJsonReader,
): Promise<ReleaseCutGate> => {
  const payload = await readJson(
    `/actions/workflows/${spec.workflow}/runs?head_sha=${sha}&event=schedule&per_page=1`,
  );
  const runs = isRecord(payload) ? payload["workflow_runs"] : undefined;
  if (!Array.isArray(runs)) {
    throw new MaintenanceReleaseError(
      `GitHub ${spec.workflow} runs returned an unexpected payload`,
    );
  }
  const entries: unknown[] = runs;
  const latest = entries.at(0);
  if (!isRecord(latest)) {
    return {
      context: spec.context,
      workflow: spec.workflow,
      state: "missing",
      evidence: "no status and no scheduled run on the commit",
      runUrl: null,
      failingJobs: [],
    };
  }
  if (latest["head_sha"] !== sha || latest["event"] !== "schedule") {
    throw new MaintenanceReleaseError(
      `GitHub ${spec.workflow} runs returned a run for another commit or event`,
    );
  }
  const runUrl =
    typeof latest["html_url"] === "string" ? latest["html_url"] : null;
  let state: ReleaseCutGate["state"] = "failure";
  if (latest["status"] !== "completed") {
    state = "pending";
  } else if (latest["conclusion"] === "success") {
    state = "success";
  }
  return {
    context: spec.context,
    workflow: spec.workflow,
    state,
    evidence: `no status; latest scheduled run ${String(latest["status"])}/${String(latest["conclusion"])}`,
    runUrl,
    failingJobs:
      state === "success" ? [] : await failingJobNames(runUrl, readJson),
  };
};

/**
 * The cut is release-ready only when main/heavy and main/pr-depth are green on
 * the commit it is cut from: their latest bot-reported status, or, for
 * main/pr-depth without a status, its latest scheduled run on the commit.
 * Anything unread or unknown is not green.
 */
export const readReleaseCutGates = async (
  sha: string,
  readJson: GitHubJsonReader = readGitHubJson,
): Promise<readonly ReleaseCutGate[]> => {
  const unreadable = (
    spec: ReleaseCutGateSpec,
    cause: unknown,
  ): ReleaseCutGate => ({
    context: spec.context,
    workflow: spec.workflow,
    state: "unreadable",
    evidence: cause instanceof Error ? cause.message : String(cause),
    runUrl: null,
    failingJobs: [],
  });
  const statusesResult = await Result.tryPromise(async () =>
    readGitHubPages(`/commits/${sha}/statuses`, readJson, (payload) => payload),
  );
  if (Result.isError(statusesResult)) {
    return RELEASE_CUT_GATES.map((spec) =>
      unreadable(spec, statusesResult.error.cause),
    );
  }
  const statuses = statusesResult.value;
  const readGate = async (
    spec: ReleaseCutGateSpec,
  ): Promise<ReleaseCutGate> => {
    // Statuses arrive newest first, so a later failure replaces a success.
    const status = statuses.find(
      (entry) => isRecord(entry) && entry["context"] === spec.context,
    );
    if (isRecord(status)) {
      return gateFromStatus(spec, status, readJson);
    }
    if (spec.scheduledRunFallback) {
      return gateFromScheduledRun(spec, sha, readJson);
    }
    return {
      context: spec.context,
      workflow: spec.workflow,
      state: "missing",
      evidence: "no status on the commit",
      runUrl: null,
      failingJobs: [],
    };
  };
  return Promise.all(
    RELEASE_CUT_GATES.map(async (spec) => {
      const gate = await Result.tryPromise(async () => readGate(spec));
      return Result.isOk(gate)
        ? gate.value
        : unreadable(spec, gate.error.cause);
    }),
  );
};

/** Null when every gate is green; otherwise the lines that say why not. */
export const releaseCutRefusal = (
  sha: string,
  gates: readonly ReleaseCutGate[],
): string | null => {
  const red = gates.filter(({ state }) => state !== "success");
  if (red.length === 0) {
    return null;
  }
  return [
    `main is not release-ready at ${sha}:`,
    ...red.flatMap((gate) => [
      `  ${gate.context}: ${gate.state} (${gate.evidence})${gate.runUrl === null ? "" : ` ${gate.runUrl}`}`,
      ...gate.failingJobs.map((job) => `    failing job: ${job}`),
      ...(gate.state === "missing" || gate.state === "failure"
        ? [
            `    run it: gh workflow run ${gate.workflow} --ref main -f sha=${sha}`,
          ]
        : []),
    ]),
  ].join("\n");
};

const resolveHeadSha = (rootDir: string): string => {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
    cwd: rootDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  const sha = result.stdout.toString().trim();
  if (!result.success || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new MaintenanceReleaseError("Could not resolve the HEAD commit");
  }
  return sha;
};

/**
 * Refuses the cut unless main/heavy and main/pr-depth are green on it. With
 * --allow-unproven-main the same verdict is printed and the cut goes on.
 */
export const assertReleaseCutReady = async (
  sha: string,
  allowUnprovenMain: boolean,
  readJson: GitHubJsonReader = readGitHubJson,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<void> => {
  const refusal = releaseCutRefusal(
    sha,
    await readReleaseCutGates(sha, readJson),
  );
  if (refusal === null) {
    write(
      `maintenance-release: main/heavy and main/pr-depth are green on ${sha}\n`,
    );
    return;
  }
  if (!allowUnprovenMain) {
    throw new MaintenanceReleaseError(
      `${refusal}\nCut from a commit where both are green, or pass ${ALLOW_UNPROVEN_MAIN_FLAG} to cut anyway.`,
    );
  }
  write(
    `maintenance-release: ${ALLOW_UNPROVEN_MAIN_FLAG} passed; cutting anyway.\n${refusal}\n`,
  );
};

export const staleCaptureIds = (): string[] => [
  ...new Set(
    computeProvenanceVerdicts()
      .filter(({ status }) => status === "STALE")
      .map(({ captureId }) => captureId),
  ),
];

const ensureFreshRecordings = (reviewReason: string) => {
  const stale = staleCaptureIds();
  if (stale.length === 0) {
    return;
  }
  process.stdout.write(
    [
      `maintenance-release: carrying stale recordings forward: ${stale.join(", ")}`,
      `  attestation: ${reviewReason}`,
      "  Re-record instead with `bun run marketing:reshoot`.",
      "",
    ].join("\n"),
  );
  run([
    "bun",
    "scripts/verify-marketing-recordings.ts",
    CONFIRMATION_FLAG,
    REASON_FLAG,
    reviewReason,
  ]);
  const unresolved = staleCaptureIds();
  if (unresolved.length > 0) {
    throw new MaintenanceReleaseError(
      `Recordings remain stale after verification: ${unresolved.join(", ")}`,
    );
  }
};

/** The verdict of one pre-cut gate. */
export type CutGateOutcome =
  | { readonly passed: true }
  | { readonly passed: false; readonly detail: string };

export type CutGateContext = {
  readonly baseSha: string;
  readonly rootDir: string;
  readonly write: (text: string) => void;
};

/** Decides one pre-cut gate; the cut takes it as a parameter. */
export type CutGateRunner = (
  gate: PreCutGate,
  context: CutGateContext,
) => Promise<CutGateOutcome>;

/**
 * Runs a gate the way release-tag.yml does: the same command on the base
 * tree with the caller's environment, so an explicit waiver
 * (WAIVE_DEPENDENCY_AUDIT=true with WAIVER_REASON) reaches the dependency
 * audit exactly as the tag's waiver inputs do.
 */
export const runCutGate: CutGateRunner = async (gate, context) => {
  if (gate.check.kind === "main-statuses") {
    // Refuses by throwing; the cut reads a thrown gate as a failed one.
    await assertReleaseCutReady(
      context.baseSha,
      false,
      readGitHubJson,
      context.write,
    );
    return { passed: true };
  }
  const result = Bun.spawnSync([...gate.check.command], {
    cwd: context.rootDir,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.success) {
    return { passed: true };
  }
  return {
    passed: false,
    detail: commandGateFailureReason({
      exitCode: result.exitCode,
      stderr,
      stdout,
    }),
  };
};

const indentDetail = (detail: string): string =>
  detail
    .split("\n")
    .map((line, index) => (index === 0 ? line : `    ${line}`))
    .join("\n");

const postCutNote = (): string =>
  [
    "maintenance-release: only release-tag.yml decides, on the version commit:",
    ...postCutGates(MAINTENANCE_CUT_GATES).map(
      ({ name, reason }) => `  ${name}: ${reason}`,
    ),
    "",
  ].join("\n");

/**
 * Runs every pre-cut gate, never stopping at the first failure, and refuses
 * with one verdict naming each failed gate. `--allow-unproven-main` lets the
 * cut go on past the main/heavy and main/pr-depth gate only; its refusal is
 * still printed.
 */
export const assertPreCutGates = async ({
  allowUnprovenMain,
  context,
  runGate,
}: {
  allowUnprovenMain: boolean;
  context: CutGateContext;
  runGate: CutGateRunner;
}): Promise<void> => {
  const gates = preCutGates(MAINTENANCE_CUT_GATES);
  const failures: string[] = [];
  for (const gate of gates) {
    // One at a time: each gate prints its own output.
    const outcome = await Result.tryPromise(async () => runGate(gate, context));
    let failure: string | null = null;
    if (Result.isError(outcome)) {
      const { cause } = outcome.error;
      failure = cause instanceof Error ? cause.message : String(cause);
    } else if (!outcome.value.passed) {
      failure = outcome.value.detail;
    }
    if (failure === null) {
      continue;
    }
    if (allowUnprovenMain && gate.overriddenByAllowUnprovenMain) {
      context.write(
        `maintenance-release: ${ALLOW_UNPROVEN_MAIN_FLAG} passed; cutting anyway.\n${failure}\n`,
      );
      continue;
    }
    failures.push(`  ${gate.name}: ${indentDetail(failure)}`);
  }
  context.write(postCutNote());
  if (failures.length > 0) {
    throw new MaintenanceReleaseError(
      [
        `${String(failures.length)} of ${String(gates.length)} pre-cut release gates failed on ${context.baseSha}; nothing was written:`,
        ...failures,
      ].join("\n"),
    );
  }
  context.write(
    `maintenance-release: pre-cut release gates passed: ${gates.map(({ name }) => name).join(", ")}\n`,
  );
};

/** Everything the cut does besides its own release file writes. */
export type MaintenanceCutEffects = {
  readonly rootDir: string;
  readonly assertCleanWorktree: () => void;
  readonly resolveHeadSha: () => string;
  readonly runGate: CutGateRunner;
  readonly queueHistoryWarning: (baseSha: string) => string | null;
  readonly readPreviousRelease: (tag: string) => Promise<PreviousRelease>;
  readonly ensureFreshRecordings: (reviewReason: string) => void;
  readonly versionPackages: (rootDir: string) => void;
  /** Checks the written release: its changelog and marketing provenance. */
  readonly checkPreparedRelease: (version: string) => void;
  readonly write: (text: string) => void;
};

/**
 * The maintenance cut. Every pre-cut gate is decided before any file is
 * written, so a gate the tag would refuse leaves no version commit behind.
 */
export const cutMaintenanceRelease = async (
  args: readonly string[],
  effects: MaintenanceCutEffects,
): Promise<void> => {
  const { rootDir } = effects;
  const options = parseMaintenanceReleaseOptions(args);
  effects.assertCleanWorktree();
  const current = parseStableVersion(
    readFileSync(nodePath.join(rootDir, "VERSION"), "utf-8").trim(),
  );
  const baseSha = effects.resolveHeadSha();
  await assertPreCutGates({
    allowUnprovenMain: options.allowUnprovenMain,
    context: { baseSha, rootDir, write: effects.write },
    runGate: effects.runGate,
  });
  const queueHistoryWarning = effects.queueHistoryWarning(baseSha);
  if (queueHistoryWarning !== null) {
    effects.write(`${queueHistoryWarning}\n`);
  }
  const previousRelease = await effects.readPreviousRelease(
    `v${current.value}`,
  );
  const next = nextPatchVersion(current);
  // Read before the preparation consumes them: the changelog and marketing
  // checks below run after it, and a failure there must restore the version
  // run's writes too, or the next attempt meets a dirty worktree.
  const pending = readPendingChangesets(rootDir);
  const prepared = withFileRollback({
    operation: () => {
      effects.ensureFreshRecordings(options.recordingReviewReason);
      const release = prepareMaintenanceReleaseFiles({
        previousRelease,
        rootDir,
        versionPackages: effects.versionPackages,
      });
      effects.checkPreparedRelease(release.version);
      return release;
    },
    paths: [
      nodePath.join(rootDir, RECORDINGS_MANIFEST_PATH),
      nodePath.join(rootDir, "VERSION"),
      nodePath.join(rootDir, RELEASE_DATES_PATH),
      nodePath.join(rootDir, `docs/changelog/v${next.value}.md`),
      nodePath.join(rootDir, `docs/changelog/v${current.value}.md`),
      nodePath.join(rootDir, CHANGESET_DIRECTORY, `release-v${next.value}.md`),
      ...versionRollbackPaths(rootDir, pending),
    ],
  });
  effects.write(
    [
      `maintenance-release: prepared ${prepared.version}`,
      `  VERSION`,
      `  ${prepared.changelogPath}`,
      ...(prepared.foldedChangelogPath === null
        ? []
        : [
            `  ${prepared.foldedChangelogPath} (removed: never tagged, notes folded into ${prepared.changelogPath})`,
          ]),
      `  ${RELEASE_DATES_PATH} (${prepared.previousTag}${PREVIOUS_RELEASE_NOTE[previousRelease.kind]})`,
      ...(prepared.changesets.length === 0
        ? []
        : [
            `  package versions, changelogs and ${String(prepared.changesets.length)} consumed changeset(s): ${prepared.changesets.join(", ")}`,
          ]),
      "Review the diff, commit it, and open the release PR.",
      "Once its CI is green, add the release PR to the merge queue.",
      "",
    ].join("\n"),
  );
};

const productionCutEffects = (rootDir: string): MaintenanceCutEffects => ({
  rootDir,
  assertCleanWorktree: () => {
    assertCleanWorktree(rootDir);
  },
  resolveHeadSha: () => resolveHeadSha(rootDir),
  runGate: runCutGate,
  queueHistoryWarning: (baseSha) =>
    releaseQueueHistoryWarning(() => ({ baseSha })),
  readPreviousRelease,
  ensureFreshRecordings,
  versionPackages: runChangesetVersion,
  checkPreparedRelease: (version) => {
    run(["bash", "scripts/check-release-changelog.sh", "--version", version]);
    run(["bun", "run", "marketing:provenance", "--strict"]);
  },
  write: (text) => {
    process.stdout.write(text);
  },
});

const main = async () => {
  const args = process.argv.slice(2);
  // The release pull request refresh runs in CI on the release branch: it
  // versions files only, so the cut's gates, recordings and prompts stay out.
  if (args.length === 1 && args.at(0) === REFRESH_FLAG) {
    assertCleanWorktree(ROOT_DIR);
    const refreshed = refreshMaintenanceReleaseFiles({ rootDir: ROOT_DIR });
    process.stdout.write(`${JSON.stringify({ refreshed })}\n`);
    return;
  }
  if (args.includes(REFRESH_FLAG)) {
    throw new MaintenanceReleaseError(
      `${REFRESH_FLAG} takes no other argument`,
    );
  }
  await cutMaintenanceRelease(args, productionCutEffects(ROOT_DIR));
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`maintenance-release: ${message}`);
    process.exit(1);
  });
}
