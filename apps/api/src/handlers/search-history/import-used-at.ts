import { Result } from "better-result";

import { Temporal } from "@stll/time";

// PostgreSQL timestamp.h MIN_TIMESTAMP/END_TIMESTAMP, converted from the
// PostgreSQL epoch in microseconds to Unix epoch nanoseconds.
const POSTGRES_TIMESTAMP_BOUNDS = {
  minInclusiveEpochNanoseconds: -210_866_803_200_000_000_000n,
  maxExclusiveEpochNanoseconds: 9_224_318_016_000_000_000_000n,
} as const;

/** A representable kept-entry time, never later than now. */
export const readImportUsedAt = (value: string, now: Date): Date | null =>
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
      return new Date(Math.min(instant.epochMilliseconds, now.getTime()));
    })
    .unwrapOr(null);
