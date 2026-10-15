// When an accepted dependency advisory must stop being accepted.
//
// A baseline entry may carry two expiry terms:
// - `expiresOn` (YYYY-MM-DD): the acceptance lapses after that date, so a
//   temporary exception cannot outlive its review.
// - `untilPatched`: the acceptance lapses once the package's latest published
//   release is outside the advisory's vulnerable range, i.e. a fix exists and
//   the dependency should be bumped instead.
// An entry with either term also lapses once `bun audit` stops reporting its
// advisory (the dependency was bumped or dropped), so a temporary acceptance
// is removed in the change that resolves it instead of lingering.
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

type LapsedAcceptancesOptions = {
  accepted: readonly AcceptanceTerms[];
  current: readonly CurrentAdvisory[];
  /** Today's date as YYYY-MM-DD. */
  today: string;
  /** The package's latest published version, or undefined when the lookup failed. */
  latestVersion: (pkg: string) => string | undefined;
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
    if (daysRemaining < 0 || daysRemaining > ACCEPTANCE_WARNING_DAYS) {
      return [];
    }
    return [{ id, package: pkg, expiresOn }];
  });
};

export const lapsedAcceptances = ({
  accepted,
  current,
  today,
  latestVersion,
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
    if (entry.expiresOn !== undefined) {
      if (!isCalendarDate(entry.expiresOn)) {
        lapse(
          `expiresOn "${entry.expiresOn}" is not a YYYY-MM-DD calendar date`,
        );
        continue;
      }
      if (today > entry.expiresOn) {
        lapse(`the acceptance expired on ${entry.expiresOn}`);
        continue;
      }
    }
    const advisory = currentById.get(entry.id);
    if (advisory === undefined) {
      lapse("the advisory is no longer reported; remove the acceptance");
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
    if (!Bun.semver.satisfies(latest, advisory.vulnerableVersions)) {
      lapse(
        `${entry.package}@${latest} is outside the vulnerable range ${advisory.vulnerableVersions}; a patched release exists`,
      );
    }
  }
  return lapsed;
};
