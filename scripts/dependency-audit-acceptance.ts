import type { InstallableRelease } from "./dependency-audit-assessment";

// When an accepted dependency advisory must stop being accepted.
//
// A baseline entry may carry two expiry terms:
// - `expiresOn` (YYYY-MM-DD): the acceptance lapses after that date, so a
//   temporary exception cannot outlive its review.
// - `untilPatched`: the acceptance lapses 24 hours after an installable release
//   is outside the advisory's vulnerable range, leaving a remediation cycle
//   and review window before the required check fails.
// An acceptance whose advisory `bun audit` no longer reports never lapses:
// nothing is left to fail on, so the guard warns and the scheduled
// remediation removes the stale entry instead.
// Anything that cannot be evaluated fails closed: a date that is not a real
// calendar day, a non-boolean `untilPatched`, an advisory without a
// vulnerable range, or a registry lookup that failed.

export type AcceptanceTerms = {
  id: string;
  package: string;
  expiresOn?: string;
  /** Read from a hand-edited file, so anything but a boolean fails closed. */
  untilPatched?: unknown;
};

export type CurrentAdvisory = {
  id: string;
  vulnerableVersions: string;
};

export type LapsedAcceptance = {
  id: string;
  package: string;
  reason: string;
};

export type ExpiringAcceptance = {
  id: string;
  package: string;
  expiresOn: string;
};

export type PatchedAcceptanceWindow = {
  id: string;
  package: string;
  installableSince: string;
  lapsesAt: string;
};

export const PATCH_ACCEPTANCE_GRACE_MS = 24 * 60 * 60 * 1000;

const firstPatchedRelease = (
  releases: readonly InstallableRelease[],
  vulnerableVersions: string,
) =>
  releases
    .filter(({ version }) => !Bun.semver.satisfies(version, vulnerableVersions))
    .toSorted(
      (left, right) =>
        Date.parse(left.installableSince) - Date.parse(right.installableSince),
    )
    .at(0);

type LapsedAcceptancesOptions = {
  accepted: readonly AcceptanceTerms[];
  current: readonly CurrentAdvisory[];
  /** Today's date as YYYY-MM-DD. */
  today: string;
  /** Date expiry can be scoped to owner changes; defaults to enforcing it. */
  enforceDateExpiry?: boolean;
  /** All stable installable releases, or undefined when lookup failed. */
  releasesForPackage: (
    pkg: string,
  ) => readonly InstallableRelease[] | undefined;
  now: Date;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const ACCEPTANCE_WARNING_DAYS = 7;

// The shape alone admits "2026-13-45", which would compare as a later date
// and extend the acceptance; a real day survives a UTC round trip unchanged.
const isCalendarDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  );
};

type ExpiringAcceptancesOptions = {
  accepted: readonly AcceptanceTerms[];
  current: readonly CurrentAdvisory[];
  /** Today's date as YYYY-MM-DD. */
  today: string;
};

export const expiringAcceptances = ({
  accepted,
  current,
  today,
}: ExpiringAcceptancesOptions): ExpiringAcceptance[] => {
  if (!isCalendarDate(today)) {
    return [];
  }
  const currentIds = new Set(current.map(({ id }) => id));
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  return accepted.flatMap(({ id, package: pkg, expiresOn }) => {
    if (
      expiresOn === undefined ||
      !isCalendarDate(expiresOn) ||
      !currentIds.has(id)
    ) {
      return [];
    }
    const daysRemaining =
      (Date.parse(`${expiresOn}T00:00:00Z`) - todayTime) / 86_400_000;
    if (daysRemaining > ACCEPTANCE_WARNING_DAYS) {
      return [];
    }
    return [{ id, package: pkg, expiresOn }];
  });
};

export const lapsedAcceptances = ({
  accepted,
  current,
  today,
  enforceDateExpiry = true,
  releasesForPackage,
  now,
}: LapsedAcceptancesOptions): LapsedAcceptance[] => {
  const currentById = new Map(
    current.map((advisory) => [advisory.id, advisory]),
  );
  const lapsed: LapsedAcceptance[] = [];
  for (const entry of accepted) {
    const lapse = (reason: string) =>
      lapsed.push({ id: entry.id, package: entry.package, reason });
    if (
      entry.untilPatched !== undefined &&
      typeof entry.untilPatched !== "boolean"
    ) {
      lapse("untilPatched must be true or false");
      continue;
    }
    if (entry.expiresOn === undefined && entry.untilPatched !== true) {
      continue;
    }
    if (entry.expiresOn !== undefined && !isCalendarDate(entry.expiresOn)) {
      lapse(`expiresOn "${entry.expiresOn}" is not a YYYY-MM-DD calendar date`);
      continue;
    }
    const advisory = currentById.get(entry.id);
    if (advisory === undefined) {
      continue;
    }
    if (
      enforceDateExpiry &&
      entry.expiresOn !== undefined &&
      today > entry.expiresOn
    ) {
      lapse(`the acceptance expired on ${entry.expiresOn}`);
      continue;
    }
    if (entry.untilPatched !== true) {
      continue;
    }
    if (advisory.vulnerableVersions === "") {
      lapse("the advisory reports no vulnerable range to compare against");
      continue;
    }
    const releases = releasesForPackage(entry.package);
    if (releases === undefined || releases.length === 0) {
      lapse(`the installable ${entry.package} releases could not be looked up`);
      continue;
    }
    const firstPatch = firstPatchedRelease(
      releases,
      advisory.vulnerableVersions,
    );
    if (firstPatch !== undefined) {
      const lapsesAt =
        Date.parse(firstPatch.installableSince) + PATCH_ACCEPTANCE_GRACE_MS;
      if (now.getTime() < lapsesAt) {
        continue;
      }
      lapse(
        `${entry.package}@${firstPatch.version} is outside the vulnerable range ${advisory.vulnerableVersions}; a patched release has been installable since ${firstPatch.installableSince}`,
      );
    }
  }
  return lapsed;
};

export const patchedAcceptanceWindows = ({
  accepted,
  current,
  releasesForPackage,
}: Pick<
  LapsedAcceptancesOptions,
  "accepted" | "current" | "releasesForPackage"
>): PatchedAcceptanceWindow[] => {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return accepted.flatMap((entry) => {
    if (entry.untilPatched !== true) {
      return [];
    }
    const advisory = currentById.get(entry.id);
    const releases = releasesForPackage(entry.package);
    if (
      advisory === undefined ||
      advisory.vulnerableVersions === "" ||
      releases === undefined
    ) {
      return [];
    }
    const firstPatch = firstPatchedRelease(
      releases,
      advisory.vulnerableVersions,
    );
    if (firstPatch === undefined) {
      return [];
    }
    return [
      {
        id: entry.id,
        package: entry.package,
        installableSince: firstPatch.installableSince,
        lapsesAt: new Date(
          Date.parse(firstPatch.installableSince) + PATCH_ACCEPTANCE_GRACE_MS,
        ).toISOString(),
      },
    ];
  });
};
