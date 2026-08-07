import { panic } from "better-result";

/**
 * The CLI compatibility contract the API advertises, as one validated value.
 *
 * This is the legacy compatibility shape consumed by CLIs published before
 * contract-revision negotiation. New CLIs use `stella_contract` instead, so
 * this band is frozen after the transition release and no longer follows each
 * package version. Its only invariant is:
 *
 *   minimum <= maximum
 *
 * Construction still validates the frozen shim at API boot, so an accidental
 * edit cannot expose an inverted transition range to legacy clients.
 */
export type CliSupportBand = {
  readonly minimum: string;
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
  if (compareSemver(band.minimum, band.maximum) > 0) {
    return panic(
      `cli-support-band: minimum ${band.minimum} is newer than maximum ${band.maximum}`,
    );
  }
  return band;
};
