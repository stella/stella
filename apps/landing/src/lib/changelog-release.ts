export type ReleaseKind = "major" | "minor" | "patch";

export type ChangelogReleaseEntry<T> =
  | { type: "maintenance"; releases: [T, ...T[]] }
  | { type: "release"; release: T };

export const CHANGELOG_ENTRIES_PER_PAGE = 12;

const STELLA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const MAINTENANCE_RELEASE_TITLE = "Maintenance release";
const MAINTENANCE_RELEASES_TITLE = "Maintenance releases";

export const isStellaReleaseTag = (tagName: string) =>
  STELLA_RELEASE_TAG_PATTERN.test(tagName);

export const getReleaseKind = (tagName: string): ReleaseKind => {
  const [, minor, patch] = tagName.replace(/^v/u, "").split(".").map(Number);

  if (patch !== 0) {
    return "patch";
  }

  return minor === 0 ? "major" : "minor";
};

export const getMaintenanceReleaseTitle = (releaseCount: number) =>
  releaseCount === 1 ? MAINTENANCE_RELEASE_TITLE : MAINTENANCE_RELEASES_TITLE;

export const formatMaintenanceReleaseRange = <T>(
  releases: readonly [T, ...T[]],
  getTagName: (release: T) => string,
) => {
  const newestRelease = releases[0];
  const oldestRelease = releases.at(-1) ?? newestRelease;
  const newestVersion = getTagName(newestRelease).replace(/^v/u, "");
  const oldestVersion = getTagName(oldestRelease).replace(/^v/u, "");

  return newestVersion === oldestVersion
    ? newestVersion
    : `${oldestVersion} – ${newestVersion}`;
};

export const groupMaintenanceReleases = <T>(
  releases: readonly T[],
  getTitle: (release: T) => string | null,
): ChangelogReleaseEntry<T>[] => {
  const entries: ChangelogReleaseEntry<T>[] = [];

  for (const release of releases) {
    if (getTitle(release) !== MAINTENANCE_RELEASE_TITLE) {
      entries.push({ type: "release", release });
      continue;
    }

    const previousEntry = entries.at(-1);
    if (previousEntry?.type === "maintenance") {
      previousEntry.releases.push(release);
      continue;
    }

    entries.push({ type: "maintenance", releases: [release] });
  }

  return entries;
};
