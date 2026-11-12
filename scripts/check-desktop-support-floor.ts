#!/usr/bin/env bun

// The desktop support floor moves with the releases.
//
// A desktop build is supported until a newer build has been published for
// `supportDays` (docs/releases.md, "Desktop Support"). The floor is therefore
// the newest desktop build published at least that long ago, and the API
// refuses desktop builds below it. The maintenance cut writes that version to
// apps/api/src/lib/mcp-connectors/desktop-support-floor.json in the release
// change it prepares (`moveDesktopSupportFloor`).
//
// Run as a pre-cut gate, this refuses only what the cut cannot repair: a
// committed floor that is no promoted release or lies above every published
// desktop build, release dates that do not parse, and a checkout without the
// tags to compare. A floor that is merely due to move passes.
//
// A stable release republishes the previous desktop build when nothing the
// desktop ships changed (scripts/detect-desktop-release-changes.sh), so the
// desktop's versions have gaps. A floor at a release with no build of its own
// could lie above every published build and refuse users who have nothing to
// update to; only a release whose desktop paths differ from the promoted
// release before it counts as a build. A build that was forced by hand, or a
// release whose desktop workflow never published, is not visible here: the
// first keeps the floor lower than it could be, the second leaves the release
// incomplete on its own.
//
// Offline: release dates come from the release publication manifest and the
// path comparison from the tags in the checkout. Dependency-free, like the
// other cut gates.
//
//   bun scripts/check-desktop-support-floor.ts
//
// Exit codes: 0 the cut can set the floor, 1 the committed floor needs a
// person, 2 the guard could not decide.

import { readFileSync } from "node:fs";
import path from "node:path";

import { parseReleaseManifest } from "./promoted-release-policy";

export const DESKTOP_SUPPORT_FLOOR_PATH =
  "apps/api/src/lib/mcp-connectors/desktop-support-floor.json";
const RELEASE_DATES_PATH = "apps/landing/src/data/changelog-release-dates.json";
const DESKTOP_REBUILD_PATHS_OWNER = "scripts/detect-desktop-release-changes.sh";

const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;

class DesktopSupportFloorError extends Error {
  readonly _tag = "DesktopSupportFloorError";

  constructor(message: string) {
    super(message);
    this.name = "DesktopSupportFloorError";
  }
}

type DesktopSupportFloor = {
  readonly minimumVersion: string;
  readonly supportDays: number;
};

type DesktopSupportFloorResolution =
  | {
      readonly status: "resolved";
      readonly minimumVersion: string;
      readonly publishedAt: string;
    }
  | { readonly status: "refused"; readonly message: string };

type DesktopSupportFloorOptions = {
  /** The committed floor: the version the API refuses below today. */
  readonly floor: DesktopSupportFloor;
  /** The publication manifest's tags: a time, or null when never promoted. */
  readonly releases: Readonly<Record<string, string | null>>;
  /**
   * Whether the release at `tag` published a desktop build of its own, given
   * the promoted release before it.
   */
  readonly isDesktopBuild: (tag: string, previousTag: string) => boolean;
  readonly now: Date;
};

const refused = (message: string): DesktopSupportFloorResolution => ({
  status: "refused",
  message,
});

/**
 * The floor as of `now`: the newest desktop build published at least
 * `supportDays` before it. The result is always a published build, so it never
 * exceeds the build the updater offers. Refused when the committed floor is
 * not a state a cut may overwrite silently: no promoted release, or above
 * every published build, where the API already refuses users who have nothing
 * to update to.
 */
export const resolveDesktopSupportFloor = ({
  floor,
  releases,
  isDesktopBuild,
  now,
}: DesktopSupportFloorOptions): DesktopSupportFloorResolution => {
  const promoted = Object.entries(releases)
    .flatMap(([tag, publishedAt]) =>
      publishedAt === null
        ? []
        : [
            {
              tag,
              version: tag.slice(1),
              publishedAt,
              publishedAtMs: Date.parse(publishedAt),
            },
          ],
    )
    .toSorted((left, right) => Bun.semver.order(left.version, right.version));
  const undated = promoted.find(({ publishedAtMs }) =>
    Number.isNaN(publishedAtMs),
  );
  if (undated !== undefined) {
    return refused(
      `${RELEASE_DATES_PATH} has an invalid publication time for ${undated.tag}`,
    );
  }
  const floorIndex = promoted.findIndex(
    ({ version }) => version === floor.minimumVersion,
  );
  if (floorIndex === -1) {
    return refused(
      `the desktop support floor ${floor.minimumVersion} is not a promoted release in ${RELEASE_DATES_PATH}`,
    );
  }

  // Each comparison reads the tags, and both searches below can ask about the
  // same release.
  const builds = new Map<string, boolean>();
  const isBuild = ({ tag }: { tag: string }, index: number): boolean => {
    const known = builds.get(tag);
    if (known !== undefined) {
      return known;
    }
    const previous = index === 0 ? undefined : promoted.at(index - 1);
    const built = previous === undefined || isDesktopBuild(tag, previous.tag);
    builds.set(tag, built);
    return built;
  };
  const newestFrom = (
    lowest: number,
    accepts: (release: (typeof promoted)[number], index: number) => boolean,
  ) => {
    for (let index = promoted.length - 1; index >= lowest; index -= 1) {
      const release = promoted.at(index);
      if (release !== undefined && accepts(release, index)) {
        return release;
      }
    }
    return undefined;
  };

  if (newestFrom(floorIndex, isBuild) === undefined) {
    return refused(
      `the desktop support floor ${floor.minimumVersion} is above every published desktop build: no release from it on published a build of its own. Set minimumVersion in ${DESKTOP_SUPPORT_FLOOR_PATH} to a published build`,
    );
  }
  const cutoffMs = now.getTime() - floor.supportDays * DAY_MS;
  // The date decides first, so tags are compared only for old enough releases.
  const resolved = newestFrom(
    0,
    (release, index) =>
      release.publishedAtMs <= cutoffMs && isBuild(release, index),
  );
  return resolved === undefined
    ? refused(
        `no desktop build has been published for ${String(floor.supportDays)} days, so there is no desktop support floor to set`,
      )
    : {
        status: "resolved",
        minimumVersion: resolved.version,
        publishedAt: resolved.publishedAt,
      };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readDesktopSupportFloor = (
  rootDir: string,
): DesktopSupportFloor => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(rootDir, DESKTOP_SUPPORT_FLOOR_PATH), "utf-8"),
  );
  if (!isRecord(parsed)) {
    throw new DesktopSupportFloorError(
      `${DESKTOP_SUPPORT_FLOOR_PATH} must be an object`,
    );
  }
  const { minimumVersion, supportDays } = parsed;
  if (
    typeof minimumVersion !== "string" ||
    !STABLE_VERSION.test(minimumVersion)
  ) {
    throw new DesktopSupportFloorError(
      `${DESKTOP_SUPPORT_FLOOR_PATH}: minimumVersion must be a stable version such as 1.2.3`,
    );
  }
  if (
    typeof supportDays !== "number" ||
    !Number.isInteger(supportDays) ||
    supportDays < 1
  ) {
    throw new DesktopSupportFloorError(
      `${DESKTOP_SUPPORT_FLOOR_PATH}: supportDays must be a positive whole number of days`,
    );
  }
  return { minimumVersion, supportDays };
};

const REBUILD_PATHS_BLOCK = /^rebuild_paths=\(\n([\s\S]*?)^\)$/mu;
const QUOTED_PATH = /^\s*"([^"]+)"$/u;

/** The paths whose change makes a release build the desktop. */
export const readDesktopRebuildPaths = (rootDir: string): readonly string[] => {
  const block = REBUILD_PATHS_BLOCK.exec(
    readFileSync(path.join(rootDir, DESKTOP_REBUILD_PATHS_OWNER), "utf-8"),
  )?.at(1);
  const paths = (block ?? "")
    .split("\n")
    .flatMap((line) => QUOTED_PATH.exec(line)?.at(1) ?? []);
  if (paths.length === 0) {
    throw new DesktopSupportFloorError(
      `${DESKTOP_REBUILD_PATHS_OWNER} declares no rebuild_paths`,
    );
  }
  return paths;
};

const GIT_DIFF_SAME = 0;
const GIT_DIFF_DIFFERENT = 1;

const tagsDiffer =
  (
    rootDir: string,
    paths: readonly string[],
  ): DesktopSupportFloorOptions["isDesktopBuild"] =>
  (tag, previousTag) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        rootDir,
        "diff",
        "--quiet",
        previousTag,
        tag,
        "--",
        ...paths,
      ],
      { stderr: "pipe", stdout: "ignore" },
    );
    if (result.exitCode === GIT_DIFF_SAME) {
      return false;
    }
    if (result.exitCode === GIT_DIFF_DIFFERENT) {
      return true;
    }
    // A missing tag or a shallow history must not read as "no build".
    throw new DesktopSupportFloorError(
      `cannot compare ${previousTag} with ${tag}; the checkout needs full history and tags: ${result.stderr.toString().trim()}`,
    );
  };

/** Whether two tags differ in what the desktop ships, read from the checkout. */
export const desktopBuildsFromTags = (
  rootDir: string,
): DesktopSupportFloorOptions["isDesktopBuild"] =>
  tagsDiffer(rootDir, readDesktopRebuildPaths(rootDir));

type MoveDesktopSupportFloorOptions = Omit<
  DesktopSupportFloorOptions,
  "floor"
> & {
  readonly rootDir: string;
  readonly writeFile: (path: string, contents: string) => void;
};

export type DesktopSupportFloorMove = {
  readonly from: string;
  readonly to: string;
};

/**
 * Writes the floor that `now` and the release dates give. The cut calls this
 * in the release change it prepares, with the manifest that change carries.
 */
export const moveDesktopSupportFloor = ({
  rootDir,
  writeFile,
  ...inputs
}: MoveDesktopSupportFloorOptions): DesktopSupportFloorMove => {
  const floor = readDesktopSupportFloor(rootDir);
  const resolution = resolveDesktopSupportFloor({ floor, ...inputs });
  if (resolution.status === "refused") {
    throw new DesktopSupportFloorError(resolution.message);
  }
  const moved = {
    minimumVersion: resolution.minimumVersion,
    supportDays: floor.supportDays,
  } satisfies DesktopSupportFloor;
  writeFile(
    path.join(rootDir, DESKTOP_SUPPORT_FLOOR_PATH),
    `${JSON.stringify(moved, null, 2)}\n`,
  );
  return { from: floor.minimumVersion, to: resolution.minimumVersion };
};

const EXIT_REFUSED = 1;
const EXIT_UNDECIDED = 2;

if (import.meta.main) {
  try {
    const rootDir = path.resolve(import.meta.dirname, "..");
    const manifest = parseReleaseManifest(
      JSON.parse(readFileSync(path.join(rootDir, RELEASE_DATES_PATH), "utf-8")),
    );
    if (manifest.status === "invalid") {
      throw new DesktopSupportFloorError(
        `${RELEASE_DATES_PATH}: ${manifest.message}`,
      );
    }
    const floor = readDesktopSupportFloor(rootDir);
    const resolution = resolveDesktopSupportFloor({
      floor,
      releases: manifest.manifest.releases,
      isDesktopBuild: desktopBuildsFromTags(rootDir),
      // The gate's own clock: it asks what a cut made now would write.
      now: new Date(),
    });
    if (resolution.status === "refused") {
      console.error(`::error::${resolution.message}`);
      process.exit(EXIT_REFUSED);
    }
    console.log(
      resolution.minimumVersion === floor.minimumVersion
        ? `desktop-support-floor: ${floor.minimumVersion} is current`
        : `desktop-support-floor: the cut moves ${floor.minimumVersion} to ${resolution.minimumVersion}`,
    );
  } catch (error) {
    if (!(error instanceof DesktopSupportFloorError)) {
      throw error;
    }
    console.error(`::error::desktop-support-floor: ${error.message}`);
    process.exit(EXIT_UNDECIDED);
  }
}
