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

export type LatestInstallableRelease = {
  version: string;
  installableSince: string;
};

export type PatchedAcceptanceWindow = {
  id: string;
  package: string;
  installableSince: string;
  lapsesAt: string;
};

export const PATCH_ACCEPTANCE_GRACE_MS = 24 * 60 * 60 * 1000;

type LapsedAcceptancesOptions = {
  accepted: readonly AcceptanceTerms[];
  current: readonly CurrentAdvisory[];
  /** Today's date as YYYY-MM-DD. */
  today: string;
  /** Date expiry can be scoped to owner changes; defaults to enforcing it. */
  enforceDateExpiry?: boolean;
  /** The package's latest installable release, or undefined when lookup failed. */
  latestVersion: (pkg: string) => LatestInstallableRelease | undefined;
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
  latestVersion,
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
    const latest = latestVersion(entry.package);
    if (latest === undefined) {
      lapse(`the latest ${entry.package} release could not be looked up`);
      continue;
    }
    if (!Bun.semver.satisfies(latest.version, advisory.vulnerableVersions)) {
      const lapsesAt =
        Date.parse(latest.installableSince) + PATCH_ACCEPTANCE_GRACE_MS;
      if (now.getTime() < lapsesAt) {
        continue;
      }
      lapse(
        `${entry.package}@${latest.version} is outside the vulnerable range ${advisory.vulnerableVersions}; a patched release has been installable since ${latest.installableSince}`,
      );
    }
  }
  return lapsed;
};

export const patchedAcceptanceWindows = ({
  accepted,
  current,
  latestVersion,
}: Pick<
  LapsedAcceptancesOptions,
  "accepted" | "current" | "latestVersion"
>): PatchedAcceptanceWindow[] => {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return accepted.flatMap((entry) => {
    if (entry.untilPatched !== true) {
      return [];
    }
    const advisory = currentById.get(entry.id);
    const latest = latestVersion(entry.package);
    if (
      advisory === undefined ||
      advisory.vulnerableVersions === "" ||
      latest === undefined ||
      Bun.semver.satisfies(latest.version, advisory.vulnerableVersions)
    ) {
      return [];
    }
    return [
      {
        id: entry.id,
        package: entry.package,
        installableSince: latest.installableSince,
        lapsesAt: new Date(
          Date.parse(latest.installableSince) + PATCH_ACCEPTANCE_GRACE_MS,
        ).toISOString(),
      },
    ];
  });
};
