import { panic } from "better-result";
import * as v from "valibot";

// Ignore subsecond noise while rejecting a fourfold change in whole-file time.
const TEST_DURATION_DRIFT_FACTOR = 4;
const MIN_COMPARISON_SECONDS = 1;

export const TEST_DURATION_SOURCE = {
  measured: "measured",
  estimated: "estimated",
} as const;

const durationSchema = v.record(
  v.string(),
  v.strictObject({
    seconds: v.pipe(v.number(), v.finite(), v.minValue(0)),
    source: v.picklist(Object.values(TEST_DURATION_SOURCE)),
  }),
);

export const readDurationWeights = (value: unknown) =>
  v.parse(durationSchema, value);

export const durationSeconds = (value: unknown) =>
  Object.fromEntries(
    Object.entries(readDurationWeights(value)).map(([file, { seconds }]) => [
      file,
      seconds,
    ]),
  );

const timingSchema = v.strictObject({
  version: v.literal(1),
  files: v.record(v.string(), v.pipe(v.number(), v.finite(), v.minValue(0))),
});

/** Bun records whole-file milliseconds, including imports and test hooks. */
export const readTimingArtifact = (contents: string) => {
  const parsed: unknown = JSON.parse(contents);
  const { files } = v.parse(timingSchema, parsed);
  return Object.fromEntries(
    Object.entries(files).map(([file, milliseconds]) => [
      file.replace(/^\.\//u, ""),
      milliseconds / 1000,
    ]),
  );
};

type AssertTestDurationsOptions = {
  files: readonly string[];
  durations: ReturnType<typeof readDurationWeights>;
  measurements?: Readonly<Record<string, number>>;
};

export const assertTestDurations = ({
  files,
  durations,
  measurements = {},
}: AssertTestDurationsOptions): void => {
  for (const file of files) {
    const entry = durations[file];
    if (entry === undefined) {
      panic(
        `Missing API test duration: ${file}; run bun apps/api/scripts/refresh-test-durations.ts --write`,
      );
    }
    const recorded = entry.seconds;
    if (!Number.isFinite(recorded) || recorded < 0) {
      panic(`Invalid duration for ${file}`);
    }
    const measured = measurements[file];
    if (
      measured === undefined ||
      entry.source === TEST_DURATION_SOURCE.estimated
    ) {
      continue;
    }
    if (!Number.isFinite(measured) || measured < 0) {
      panic(`Invalid measurement for ${file}`);
    }
    const previous = Math.max(MIN_COMPARISON_SECONDS, recorded);
    const latest = Math.max(MIN_COMPARISON_SECONDS, measured);
    if (
      Math.max(previous, latest) / Math.min(previous, latest) >
      TEST_DURATION_DRIFT_FACTOR
    ) {
      panic(
        `Stale API test duration: ${file} (${recorded}s recorded, ${measured}s measured); run bun apps/api/scripts/refresh-test-durations.ts --write <timing-artifact-directory>`,
      );
    }
  }
};
