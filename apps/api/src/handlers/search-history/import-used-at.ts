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

type ImportClock = NonNullable<ReturnType<typeof readImportClock>>;

/** Correct device time before comparing it with server deletion cutoffs. */
export const readImportUsedAt = (
  value: string,
  { serverNowMs, offsetNanoseconds }: ImportClock,
): Date | null => {
  const usedAt = readImportTimestamp(value);
  if (usedAt === null) {
    return null;
  }
  const correctedNanoseconds = usedAt.epochNanoseconds + offsetNanoseconds;
  if (
    correctedNanoseconds > BigInt(serverNowMs) * 1_000_000n ||
    correctedNanoseconds <
      POSTGRES_TIMESTAMP_BOUNDS.minInclusiveEpochNanoseconds
  ) {
    return null;
  }
  return new Date(
    Temporal.Instant.fromEpochNanoseconds(correctedNanoseconds)
      .epochMilliseconds,
  );
};

/** Anchor subtraction cancels transit and any application/database clock difference. */
export const importUseCutoffLowerBound = (
  usedAt: Date,
  importClockMarginMs: number,
) =>
  new Date(
    Temporal.Instant.fromEpochMilliseconds(usedAt.getTime()).subtract({
      milliseconds: importClockMarginMs,
    }).epochMilliseconds,
  );
