import { panic } from "better-result";

/**
 * The CLI compatibility contract the API advertises, as one validated value.
 *
 * The three versions are deliberately independent — `latest` tracks what is
 * published to npm, while `maximum` may move ahead of it in the API release
 * that precedes a CLI publication — but they are bound by one invariant:
 *
 *   minimum <= latest <= maximum
 *
 * Previously these were three loose string constants, so bumping a subset left
 * the band inverted (a `latest` below `minimum`) and nothing failed until a
 * single drift test happened to run. Constructing the band through
 * `declareCliSupportBand` moves that from "a test might catch it" to "the API
 * refuses to boot", which is the correct severity: an inverted band means the
 * compatibility contract served to every client is nonsense.
 */
export type CliSupportBand = {
  readonly minimum: string;
  readonly latest: string;
  readonly maximum: string;
};

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

const parseSemver = (version: string): readonly number[] => {
  const matched = SEMVER_PATTERN.exec(version);
  if (!matched) {
    return panic(
      `cli-support-band: "${version}" is not a plain major.minor.patch version`,
    );
  }
  // SAFETY: the pattern has exactly three capture groups, so a successful
  // match always yields them.
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
};

/** Negative when `a` precedes `b`, positive when it follows, zero when equal. */
export const compareSemver = (a: string, b: string): number => {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const [index, leftPart] of left.entries()) {
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
};

/**
 * Builds the band, refusing any ordering that would advertise an incoherent
 * contract. Called at module scope so a bad edit fails at import time.
 */
export const declareCliSupportBand = (band: CliSupportBand): CliSupportBand => {
  if (compareSemver(band.minimum, band.latest) > 0) {
    return panic(
      `cli-support-band: minimum ${band.minimum} is newer than latest ${band.latest}`,
    );
  }
  if (compareSemver(band.latest, band.maximum) > 0) {
    return panic(
      `cli-support-band: latest ${band.latest} is newer than maximum ${band.maximum}`,
    );
  }
  return band;
};
