import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  durationSeconds,
  parseTestDurationWeights,
  readTestDurationWeights,
  TEST_DURATION_HISTORY_LIMIT,
  TEST_DURATION_SOURCE,
  testFileDurationWeights,
} from "@stll/scripts/src/test-shard-planning";
import { sha256Hex } from "@stll/sha256/bun";

export {
  durationSeconds,
  TEST_DURATION_HISTORY_LIMIT,
  TEST_DURATION_SOURCE,
  testFileDurationWeights,
};

export const API_TEST_DURATIONS_FILE_ENV = "API_TEST_DURATIONS_FILE";

/** Median of samples; the mean of the middle pair for an even count. */
export const medianSeconds = (samples: readonly number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? panic("Median of no samples");
  return sorted.length % 2 === 1
    ? high
    : ((sorted[middle - 1] ?? high) + high) / 2;
};

export const readDurationWeights = (value: unknown) =>
  readTestDurationWeights(value);

export const API_TEST_DURATIONS_HASH_ENV = "API_TEST_DURATIONS_HASH";
export const MISSING_TEST_DURATIONS_HASH = "missing";

type AssertTestDurationsIdentityOptions = {
  path: string | undefined;
  hash: string | undefined;
};

/**
 * Weights decide which files a shard runs, and Turbo keys shard results by the
 * declared hash: a sharded run must read exactly the weights its key names, or
 * a cached pass could stand in for files it never ran.
 */
export const assertTestDurationsIdentity = ({
  path,
  hash,
}: AssertTestDurationsIdentityOptions) => {
  const contents =
    path === undefined || path === ""
      ? undefined
      : Result.try(() => readFileSync(path)).unwrapOr(undefined);
  const actual =
    contents === undefined ? MISSING_TEST_DURATIONS_HASH : sha256Hex(contents);
  const declared =
    hash === undefined || hash === "" ? MISSING_TEST_DURATIONS_HASH : hash;
  if (declared !== actual) {
    panic(
      `${API_TEST_DURATIONS_HASH_ENV} must be the sha256 of ${API_TEST_DURATIONS_FILE_ENV} (expected ${actual}, got ${declared})`,
    );
  }
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
      const validated = parseTestDurationWeights(parsed.value);
      if (validated === undefined) {
        notice(
          `::notice::API test duration cache has an invalid schema; using uniform weights (${path})`,
        );
        fallbackNoticed = true;
      } else {
        durations = durationSeconds(validated);
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
