export const STABLE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RFC_3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

type PromotedRelease = { ref: string; promotedAt: number };

type PromotionSelection =
  | {
      status: "resolved";
      ref: string;
      promotedAt: number;
      promotions: readonly PromotedRelease[];
    }
  | { status: "invalid"; message: string }
  | { status: "missing"; message: string }
  | { status: "ambiguous"; message: string };

const parsePublicationTime = (value: string): number | null => {
  const match = RFC_3339_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  if (
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return null;
  }

  const calendarTime = new Date(0);
  calendarTime.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendarTime.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    calendarTime.toISOString().slice(0, 19) !==
    `${year}-${month}-${day}T${hour}:${minute}:${second}`
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const RELEASE_MANIFEST_NOTE_KEY = "_note";

/**
 * The release publication manifest split into its two kinds of entry: the
 * human note, and the stable tags with their publication time (null: built
 * but never promoted). Only tags ever reach version comparisons.
 */
export type ReleaseManifest = {
  readonly note: string | undefined;
  readonly releases: Readonly<Record<string, string | null>>;
};

type ParsedManifest =
  | { status: "parsed"; manifest: ReleaseManifest }
  | { status: "invalid"; message: string };

// The one reader of the manifest file: every other key must be a stable tag
// whose value is a string or null, else the whole file is invalid.
export const parseReleaseManifest = (manifest: unknown): ParsedManifest => {
  if (!isRecord(manifest)) {
    return {
      status: "invalid",
      message: "The release publication manifest must be an object.",
    };
  }
  let note: string | undefined;
  const releases: (readonly [string, string | null])[] = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (key === RELEASE_MANIFEST_NOTE_KEY) {
      if (typeof value !== "string") {
        return {
          status: "invalid",
          message: `The release publication manifest note must be a string.`,
        };
      }
      note = value;
      continue;
    }
    if (!STABLE_RELEASE_TAG.test(key)) {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid stable release ref: ${key}.`,
      };
    }
    if (typeof value !== "string" && value !== null) {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid publication time for ${key}.`,
      };
    }
    releases.push([key, value]);
  }
  return {
    status: "parsed",
    manifest: { note, releases: Object.fromEntries(releases) },
  };
};

/** The manifest file's bytes: the note first, then the tags as given. */
export const serializeReleaseManifest = ({
  note,
  releases,
}: ReleaseManifest): string =>
  `${JSON.stringify(
    note === undefined
      ? releases
      : { [RELEASE_MANIFEST_NOTE_KEY]: note, ...releases },
    null,
    2,
  )}\n`;

type ParsedPromotions =
  | {
      status: "parsed";
      promoted: { ref: string; publishedAt: string; publishedAtMs: number }[];
    }
  | { status: "invalid"; message: string };

// Null is a known unpromoted release, an absent ref was never promoted, and
// any malformed entry invalidates the whole file.
const parsePromotions = (manifest: unknown): ParsedPromotions => {
  const parsed = parseReleaseManifest(manifest);
  if (parsed.status === "invalid") {
    return parsed;
  }

  const promoted: {
    ref: string;
    publishedAt: string;
    publishedAtMs: number;
  }[] = [];
  for (const [ref, publishedAt] of Object.entries(parsed.manifest.releases)) {
    if (publishedAt === null) {
      continue;
    }
    const publishedAtMs = parsePublicationTime(publishedAt);
    if (publishedAtMs === null) {
      return {
        status: "invalid",
        message: `The release publication manifest contains an invalid publication time for ${ref}.`,
      };
    }
    promoted.push({ ref, publishedAt, publishedAtMs });
  }
  return { status: "parsed", promoted };
};

type PromotedBelowSelection =
  | { status: "resolved"; ref: string }
  | { status: "invalid"; message: string }
  | { status: "missing"; message: string };

/**
 * The newest promoted final release (highest version) strictly below a
 * version. The reference release for checks that a release's artifacts
 * reached their registries: an unpromoted tag can never be that reference.
 */
export const selectPromotedReleaseBelow = (
  manifest: unknown,
  upperBoundVersion: string,
): PromotedBelowSelection => {
  const parsed = parsePromotions(manifest);
  if (parsed.status === "invalid") {
    return parsed;
  }
  const newest = parsed.promoted
    .filter(({ ref }) => Bun.semver.order(ref.slice(1), upperBoundVersion) < 0)
    .toSorted((left, right) =>
      Bun.semver.order(right.ref.slice(1), left.ref.slice(1)),
    )
    .at(0);
  return newest === undefined
    ? {
        status: "missing",
        message: `The release publication manifest records no promoted release below ${upperBoundVersion}.`,
      }
    : { status: "resolved", ref: newest.ref };
};

// Shared by the offline release resolver and the live registry journey.
export const selectPromotedRelease = (
  manifest: unknown,
): PromotionSelection => {
  const parsed = parsePromotions(manifest);
  if (parsed.status === "invalid") {
    return parsed;
  }
  const { promoted } = parsed;

  if (promoted.length === 0) {
    return {
      status: "missing",
      message: "The release publication manifest records no promoted release.",
    };
  }

  const ordered = promoted.toSorted(
    (left, right) => right.publishedAtMs - left.publishedAtMs,
  );
  const latest = ordered.at(0);
  if (!latest) {
    return {
      status: "missing",
      message: "The release publication manifest records no promoted release.",
    };
  }
  const candidates = ordered.filter(
    ({ publishedAtMs }) => publishedAtMs === latest.publishedAtMs,
  );
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      message: `The release publication manifest records multiple releases at ${latest.publishedAt}: ${candidates.map(({ ref }) => ref).join(", ")}.`,
    };
  }

  return {
    status: "resolved",
    ref: latest.ref,
    promotedAt: latest.publishedAtMs / 1000,
    promotions: ordered.map(({ ref, publishedAtMs }) => ({
      ref,
      promotedAt: publishedAtMs / 1000,
    })),
  };
};
