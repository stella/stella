import { Result, panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

export const API_TEST_DURATIONS_FILE_ENV = "API_TEST_DURATIONS_FILE";

export const TEST_DURATION_SOURCE = {
  measured: "measured",
} as const;

const durationSchema = v.record(
  v.string(),
  v.strictObject({
    seconds: v.pipe(v.number(), v.finite(), v.minValue(0)),
    source: v.literal(TEST_DURATION_SOURCE.measured),
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

/** Resolve missing live files with the same median for shard and lane planning. */
export const testFileDurationWeights = (
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
) => {
  const measured = files
    .flatMap((file) => {
      const duration = durations[file];
      if (duration === undefined) {
        return [];
      }
      if (!Number.isFinite(duration) || duration < 0) {
        panic(`Invalid duration for ${file}`);
      }
      return [duration];
    })
    .toSorted((a, b) => a - b);
  const fallback = measured.at(Math.floor(measured.length / 2)) ?? 1;
  return Object.fromEntries(
    files.map((file) => [file, durations[file] ?? fallback]),
  );
};

type LoadTestDurationWeightsOptions = {
  files: readonly string[];
  path: string | undefined;
  notice?: (message: string) => void;
};

/** Cached main measurements are an optional external input, never a test gate. */
export const loadTestDurationWeights = ({
  files,
  path,
  notice = console.log,
}: LoadTestDurationWeightsOptions) => {
  let durations: Readonly<Record<string, number>> = {};
  let fallbackNoticed = false;
  if (path === undefined || path === "") {
    notice(
      "::notice::API test duration cache unavailable; using uniform weights",
    );
    fallbackNoticed = true;
  } else {
    const parsed = Result.try((): unknown =>
      JSON.parse(readFileSync(path, "utf-8")),
    );
    if (parsed.isErr()) {
      notice(
        `::notice::API test duration cache unreadable; using uniform weights (${path})`,
      );
      fallbackNoticed = true;
    } else {
      const validated = v.safeParse(durationSchema, parsed.value);
      if (!validated.success) {
        notice(
          `::notice::API test duration cache has an invalid schema; using uniform weights (${path})`,
        );
        fallbackNoticed = true;
      } else {
        durations = durationSeconds(validated.output);
      }
    }
  }
  const unknown = files.filter((file) => durations[file] === undefined);
  const usable = files.length - unknown.length;
  if (unknown.length > 0 && usable > 0) {
    notice(
      `::notice::${unknown.length} API test file(s) use the median duration weight`,
    );
  } else if (unknown.length > 0 && !fallbackNoticed) {
    notice(
      "::notice::API test duration cache has no live entries; using uniform weights",
    );
  }
  return testFileDurationWeights(files, durations);
};

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
