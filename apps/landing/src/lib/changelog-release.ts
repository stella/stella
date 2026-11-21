export type ChangelogReleaseEntry<T> =
  | { type: "maintenance"; releases: [T, ...T[]] }
  | { type: "release"; release: T };

export const CHANGELOG_ENTRIES_PER_PAGE = 12;

const STELLA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const MAINTENANCE_RELEASE_TITLE = "Maintenance release";
const MAINTENANCE_RELEASES_TITLE = "Maintenance releases";

export const isStellaReleaseTag = (tagName: string) =>
  STELLA_RELEASE_TAG_PATTERN.test(tagName);

/** A release whose note is headed "Maintenance release" carries no product headline. */
export const isMaintenanceRelease = (title: string | null) =>
  title === MAINTENANCE_RELEASE_TITLE;

/**
 * A feature release is any release, patch or not, whose note opens with a
 * real product headline: a `#` heading other than the maintenance title.
 */
export const isFeatureRelease = (title: string | null): title is string =>
  title !== null && !isMaintenanceRelease(title);

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
    if (!isMaintenanceRelease(getTitle(release))) {
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
