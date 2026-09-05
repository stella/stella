#!/usr/bin/env bun

import { Result } from "better-result";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

import { RECORDINGS_MANIFEST_PATH } from "../apps/web/e2e/marketing/captures";
import { computeVerdicts } from "./check-marketing-recordings";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const RELEASE_DATES_PATH = "apps/landing/src/data/changelog-release-dates.json";
const CONFIRMATION_FLAG = "--confirm-current-recordings-reviewed";
const REASON_FLAG = "--reason";
// A bare `bun run release:maintenance` carries stale recordings forward under
// this standing attestation instead of stopping the release. Pass
// CONFIRMATION_FLAG with REASON_FLAG to record a specific review instead.
const DEFAULT_REVIEW_REASON = "Patch release, UX diff negligible";
const GITHUB_API_ROOT = "https://api.github.com/repos/stella/stella";
const RELEASE_PAGE_SIZE = 100;
const RELEASE_PAGE_LIMIT = 20;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const MAINTENANCE_CHANGELOG =
  "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n";

type StableVersion = {
  major: number;
  minor: number;
  patch: number;
  value: string;
};

type MaintenanceReleaseOptions = {
  recordingReviewReason: string;
};

type PreparedMaintenanceRelease = {
  changelogPath: string;
  previousTag: string;
  version: string;
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
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MaintenanceReleaseError(`Invalid stable version part: ${value}`);
  }
  return parsed;
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
  let reason: string | undefined;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args.at(index);
    if (flag !== CONFIRMATION_FLAG && flag !== REASON_FLAG) {
      throw new MaintenanceReleaseError(`Unknown argument: ${String(flag)}`);
    }
    if (seen.has(flag)) {
      throw new MaintenanceReleaseError(`${flag} may be passed only once`);
    }
    seen.add(flag);

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
    return { recordingReviewReason: DEFAULT_REVIEW_REASON };
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
  return { recordingReviewReason: reason };
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

export const prepareMaintenanceReleaseFiles = ({
  publishedAt,
  rootDir,
  writeFile = atomicWriteFile,
}: {
  publishedAt: string | null;
  rootDir: string;
  writeFile?: ReleaseFileWriter;
}): PreparedMaintenanceRelease => {
  if (publishedAt !== null && Number.isNaN(Date.parse(publishedAt))) {
    throw new MaintenanceReleaseError(
      `Previous release has an invalid publication timestamp: ${publishedAt}`,
    );
  }

  const versionPath = nodePath.join(rootDir, "VERSION");
  const current = parseStableVersion(readFileSync(versionPath, "utf-8").trim());
  const next = nextPatchVersion(current);
  const previousTag = `v${current.value}`;
  if (
    !existsSync(nodePath.join(rootDir, "docs/changelog", `${previousTag}.md`))
  ) {
    throw new MaintenanceReleaseError(
      `Previous release changelog is missing: docs/changelog/${previousTag}.md`,
    );
  }

  const changelogPath = `docs/changelog/v${next.value}.md`;
  const absoluteChangelogPath = nodePath.join(rootDir, changelogPath);
  if (existsSync(absoluteChangelogPath)) {
    throw new MaintenanceReleaseError(
      `Next release changelog already exists: ${changelogPath}`,
    );
  }

  const releaseDatesPath = nodePath.join(rootDir, RELEASE_DATES_PATH);
  const releaseDates = readReleaseDates(rootDir);
  if (releaseDates[previousTag] !== null) {
    releaseDates[previousTag] = publishedAt;
  }
  return withFileRollback({
    operation: () => {
      // VERSION is the commit marker: every dependent file is durable before
      // it advances. Atomic sibling renames prevent truncated files.
      writeFile(absoluteChangelogPath, MAINTENANCE_CHANGELOG);
      writeFile(releaseDatesPath, `${JSON.stringify(releaseDates, null, 2)}\n`);
      writeFile(versionPath, `${next.value}\n`);
      return { changelogPath, previousTag, version: next.value };
    },
    paths: [versionPath, releaseDatesPath, absoluteChangelogPath],
    writeFile,
  });
};

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

const assertCleanWorktree = () => {
  const result = Bun.spawnSync(
    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: ROOT_DIR, stderr: "pipe", stdout: "pipe" },
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

const requestGitHub = async (path: string): Promise<Response> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "stella-maintenance-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (resolvedToken === undefined) {
    resolvedToken = resolveGitHubToken(process.env);
  }
  if (resolvedToken !== null) {
    headers["Authorization"] = `Bearer ${resolvedToken}`;
  }
  return fetch(`${GITHUB_API_ROOT}${path}`, { headers });
};

const readPublishedAt = (tag: string, payload: unknown): string | null => {
  if (!isRecord(payload)) {
    throw new MaintenanceReleaseError(
      `GitHub release ${tag} has no valid published_at timestamp`,
    );
  }
  const publishedAt = payload["published_at"];
  if (publishedAt === null || publishedAt === undefined) {
    return null;
  }
  if (
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    throw new MaintenanceReleaseError(
      `GitHub release ${tag} has no valid published_at timestamp`,
    );
  }
  return publishedAt;
};

const assertTagExists = async (tag: string) => {
  const response = await requestGitHub(
    `/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) {
    throw new MaintenanceReleaseError(
      `Previous tag ${tag} does not exist; wait for the release workflow to build it`,
    );
  }
  if (!response.ok) {
    throw new MaintenanceReleaseError(
      `Could not read tag ${tag} from GitHub (HTTP ${String(response.status)})`,
    );
  }
};

// The by-tag endpoint hides drafts, so its 404 is ambiguous. The full listing
// includes drafts for an authenticated caller and separates the two cases: a
// draft release is abandoned, no release object at all is unfinished.
const findUnpromotedRelease = async (
  tag: string,
  page: number,
): Promise<string | null> => {
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
    return release["draft"] === true ? null : readPublishedAt(tag, release);
  }
  if (entries.length < RELEASE_PAGE_SIZE) {
    throw new MaintenanceReleaseError(
      `Previous tag ${tag} has no GitHub release yet; wait for the release workflow to publish one`,
    );
  }
  return findUnpromotedRelease(tag, page + 1);
};

// `null` means the tag was built but never promoted: the release is a draft, or
// it exists without a publication date. A tag whose release was never created
// is unfinished rather than abandoned, and fails the cut instead: a `null`
// written for it would never be replaced.
export const fetchPublishedAt = async (tag: string): Promise<string | null> => {
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
  await assertTagExists(tag);
  return findUnpromotedRelease(tag, 1);
};

const staleCaptureIds = (): string[] => [
  ...new Set(
    computeVerdicts()
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

const main = async () => {
  const options = parseMaintenanceReleaseOptions(process.argv.slice(2));
  assertCleanWorktree();
  const current = parseStableVersion(
    readFileSync(nodePath.join(ROOT_DIR, "VERSION"), "utf-8").trim(),
  );
  const publishedAt = await fetchPublishedAt(`v${current.value}`);
  const next = nextPatchVersion(current);
  const prepared = withFileRollback({
    operation: () => {
      ensureFreshRecordings(options.recordingReviewReason);
      const release = prepareMaintenanceReleaseFiles({
        publishedAt,
        rootDir: ROOT_DIR,
      });
      run([
        "bash",
        "scripts/check-release-changelog.sh",
        "--version",
        release.version,
      ]);
      run(["bun", "run", "marketing:stale", "--strict"]);
      return release;
    },
    paths: [
      nodePath.join(ROOT_DIR, RECORDINGS_MANIFEST_PATH),
      nodePath.join(ROOT_DIR, "VERSION"),
      nodePath.join(ROOT_DIR, RELEASE_DATES_PATH),
      nodePath.join(ROOT_DIR, `docs/changelog/v${next.value}.md`),
    ],
  });
  process.stdout.write(
    [
      `maintenance-release: prepared ${prepared.version}`,
      `  VERSION`,
      `  ${prepared.changelogPath}`,
      `  ${RELEASE_DATES_PATH} (${prepared.previousTag}${publishedAt === null ? ": never promoted" : ""})`,
      "Review the diff, commit it, and open the release PR.",
      "",
    ].join("\n"),
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`maintenance-release: ${message}`);
    process.exit(1);
  });
}
