#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { computeVerdicts } from "./check-marketing-recordings";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const RELEASE_DATES_PATH = "apps/landing/src/data/changelog-release-dates.json";
const CONFIRMATION_FLAG = "--confirm-current-recordings-reviewed";
const REASON_FLAG = "--reason";
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
  recordingReviewReason: string | null;
};

type PreparedMaintenanceRelease = {
  changelogPath: string;
  previousTag: string;
  version: string;
};

export class MaintenanceReleaseError extends Error {
  constructor(message: string) {
    super(message);
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
    return { recordingReviewReason: null };
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

const readReleaseDates = (rootDir: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(
    readFileSync(nodePath.join(rootDir, RELEASE_DATES_PATH), "utf-8"),
  );
  if (
    !isRecord(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  ) {
    throw new MaintenanceReleaseError(
      `${RELEASE_DATES_PATH} must be an object of string values`,
    );
  }
  const releaseDates: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      releaseDates[key] = value;
    }
  }
  return releaseDates;
};

export const prepareMaintenanceReleaseFiles = ({
  publishedAt,
  rootDir,
}: {
  publishedAt: string;
  rootDir: string;
}): PreparedMaintenanceRelease => {
  if (Number.isNaN(Date.parse(publishedAt))) {
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

  const releaseDates = readReleaseDates(rootDir);
  releaseDates[previousTag] = publishedAt;
  writeFileSync(
    nodePath.join(rootDir, RELEASE_DATES_PATH),
    `${JSON.stringify(releaseDates, null, 2)}\n`,
  );
  writeFileSync(versionPath, `${next.value}\n`);
  writeFileSync(absoluteChangelogPath, MAINTENANCE_CHANGELOG);
  return { changelogPath, previousTag, version: next.value };
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

const fetchPublishedAt = async (tag: string): Promise<string> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "stella-maintenance-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(
    `https://api.github.com/repos/stella/stella/releases/tags/${encodeURIComponent(tag)}`,
    { headers },
  );
  if (!response.ok) {
    throw new MaintenanceReleaseError(
      `Could not read ${tag} from GitHub Releases (HTTP ${String(response.status)})`,
    );
  }
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload["published_at"] !== "string" ||
    Number.isNaN(Date.parse(payload["published_at"]))
  ) {
    throw new MaintenanceReleaseError(
      `GitHub release ${tag} has no valid published_at timestamp`,
    );
  }
  return payload["published_at"];
};

const staleCaptureIds = (): string[] => [
  ...new Set(
    computeVerdicts()
      .filter(({ status }) => status === "STALE")
      .map(({ captureId }) => captureId),
  ),
];

const ensureFreshRecordings = (reviewReason: string | null) => {
  const stale = staleCaptureIds();
  if (stale.length === 0) {
    return;
  }
  if (reviewReason === null) {
    throw new MaintenanceReleaseError(
      [
        `Marketing recordings require review: ${stale.join(", ")}`,
        "Re-record with `bun run marketing:reshoot`, or visually review and rerun:",
        `bun run release:maintenance -- ${CONFIRMATION_FLAG} ${REASON_FLAG} "<review reason>"`,
      ].join("\n"),
    );
  }
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
  ensureFreshRecordings(options.recordingReviewReason);
  const prepared = prepareMaintenanceReleaseFiles({
    publishedAt,
    rootDir: ROOT_DIR,
  });
  run([
    "bash",
    "scripts/check-release-changelog.sh",
    "--version",
    prepared.version,
  ]);
  run(["bun", "run", "marketing:stale", "--strict"]);
  process.stdout.write(
    [
      `maintenance-release: prepared ${prepared.version}`,
      `  VERSION`,
      `  ${prepared.changelogPath}`,
      `  ${RELEASE_DATES_PATH} (${prepared.previousTag})`,
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
