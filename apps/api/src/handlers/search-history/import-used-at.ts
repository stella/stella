import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { LIMITS } from "@/api/lib/limits";

// PostgreSQL timestamp.h MIN_TIMESTAMP/END_TIMESTAMP, converted from the
// PostgreSQL epoch in microseconds to Unix epoch nanoseconds.
const POSTGRES_TIMESTAMP_BOUNDS = {
  minInclusiveEpochNanoseconds: -210_866_803_200_000_000_000n,
  maxExclusiveEpochNanoseconds: 9_224_318_016_000_000_000_000n,
} as const;

const readImportTimestamp = (value: string) =>
  Result.try(() => Temporal.Instant.from(value))
    .map((instant) => {
      if (
        instant.epochNanoseconds <
          POSTGRES_TIMESTAMP_BOUNDS.minInclusiveEpochNanoseconds ||
        instant.epochNanoseconds >=
          POSTGRES_TIMESTAMP_BOUNDS.maxExclusiveEpochNanoseconds
      ) {
        return null;
      }
      return instant;
    })
    .unwrapOr(null);

export const readImportClock = (value: string, now: Date) => {
  const clientNow = readImportTimestamp(value);
  const serverNowMs = now.getTime();
  if (clientNow === null || !Number.isFinite(serverNowMs)) {
    return null;
  }
  const offsetNanoseconds =
    BigInt(serverNowMs) * 1_000_000n - clientNow.epochNanoseconds;
  const maxOffsetNanoseconds =
    BigInt(LIMITS.searchHistoryClockSkewMaxMs) * 1_000_000n;
  if (
    offsetNanoseconds < -maxOffsetNanoseconds ||
    offsetNanoseconds > maxOffsetNanoseconds
  ) {
    return null;
  }
  return { serverNowMs, offsetNanoseconds };
};

type ImportClock = NonNullable<ReturnType<typeof readImportClock>> & {
  issuedAtMs: number;
};

/** Persist the conservative time bound; transit must not promote an older use. */
export const readImportUsedAt = (
  value: string,
  { serverNowMs, offsetNanoseconds, issuedAtMs }: ImportClock,
): Date | null => {
  const usedAt = readImportTimestamp(value);
  if (usedAt === null) {
    return null;
  }
  const correctedNanoseconds = usedAt.epochNanoseconds + offsetNanoseconds;
  if (correctedNanoseconds > BigInt(serverNowMs) * 1_000_000n) {
    return null;
  }
  // The anchor precedes clientNow. Removing the anchor-to-receipt interval
  // cancels transit and the application/database clock difference for every
  // persisted timestamp, cutoff, latest-spelling selection, and ordering.
  const lowerBoundNanoseconds =
    correctedNanoseconds - BigInt(serverNowMs - issuedAtMs) * 1_000_000n;
  if (
    lowerBoundNanoseconds <
      POSTGRES_TIMESTAMP_BOUNDS.minInclusiveEpochNanoseconds ||
    lowerBoundNanoseconds >=
      POSTGRES_TIMESTAMP_BOUNDS.maxExclusiveEpochNanoseconds
  ) {
    return null;
  }
  return new Date(
    Temporal.Instant.fromEpochNanoseconds(lowerBoundNanoseconds)
      .epochMilliseconds,
  );
};
