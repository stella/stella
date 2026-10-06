import { panic } from "better-result";
import { readFileSync } from "node:fs";

import {
  assertTestDurations,
  durationSeconds,
  readDurationWeights,
  readTimingArtifact,
} from "./test-timings";

/** Resolve the explicit selection before duration bins partition it. */
export const restrictApiTestFiles = (
  files: readonly string[],
  selection: string | undefined,
): readonly string[] => {
  if (selection === undefined || selection === "") {
    return files;
  }
  const source = /\.test\.tsx?(?:\r?\n|$)/u.test(selection)
    ? selection
    : readFileSync(selection, "utf-8");
  const selected = source.split(/\r?\n/u).filter((file) => file !== "");
  if (selected.length === 0) {
    panic("API_TEST_FILES selected zero test files");
  }
  const known = new Set(files);
  for (const file of selected) {
    if (!known.has(file)) {
      panic(`Unknown API_TEST_FILES path: ${file}`);
    }
  }
  if (new Set(selected).size !== selected.length) {
    panic("API_TEST_FILES paths must be unique");
  }
  const wanted = new Set(selected);
  return files.filter((file) => wanted.has(file));
};

export const API_TEST_SHARD_ENV = "API_TEST_SHARD";

type PartitionTestFilesOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  count: number;
};

/** Longest-first scheduling; missing measurements use the live files' median. */
export const partitionTestFiles = ({
  files,
  durations,
  count,
}: PartitionTestFilesOptions): string[][] => {
  if (!Number.isSafeInteger(count) || count < 1) {
    panic("Test shard count must be a positive integer");
  }
  if (new Set(files).size !== files.length) {
    panic("Test paths must be unique");
  }
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
  if (count === 1) {
    return [[...files]];
  }
  const weight = (file: string) => durations[file] ?? fallback;
  const bins = Array.from({ length: count }, () => ({
    files: new Set<string>(),
    seconds: 0,
  }));
  for (const file of files.toSorted(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : Number(a > b)),
  )) {
    let bin = bins.at(0);
    if (bin === undefined) {
      panic("Test shard bins must exist");
    }
    for (const candidate of bins) {
      if (candidate.seconds < bin.seconds) {
        bin = candidate;
      }
    }
    bin.files.add(file);
    bin.seconds += weight(file);
  }
  return bins.map((bin) => files.filter((file) => bin.files.has(file)));
};

export const parseApiTestShard = (value: string | undefined) => {
  if (value === undefined || value === "") {
    return null;
  }
  const match = /^(?<index>[1-9]\d*)\/(?<count>[1-9]\d*)$/u.exec(value);
  const index = Number(match?.groups?.["index"]);
  const count = Number(match?.groups?.["count"]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index > count
  ) {
    panic(`Invalid ${API_TEST_SHARD_ENV}: expected i/n with 1 <= i <= n`);
  }
  return { index, count };
};

type SelectApiTestFilesOptions = {
  files: readonly string[];
  durations: unknown;
  shardValue: string | undefined;
};

export const selectApiTestFiles = ({
  files,
  durations,
  shardValue,
}: SelectApiTestFilesOptions) => {
  const shard = parseApiTestShard(shardValue);
  if (shard === null) {
    return { testPaths: files, shard };
  }
  const measurementPath = process.env["API_TEST_MEASUREMENTS"];
  const weights = readDurationWeights(durations);
  assertTestDurations({
    files,
    durations: weights,
    ...(measurementPath === undefined
      ? {}
      : {
          measurements: readTimingArtifact(
            readFileSync(measurementPath, "utf-8"),
          ),
        }),
  });
  const testPaths = partitionTestFiles({
    files,
    durations: durationSeconds(weights),
    count: shard.count,
  }).at(shard.index - 1);
  if (testPaths === undefined || testPaths.length === 0) {
    panic(
      `API test shard ${shard.index}/${shard.count} selected zero test files`,
    );
  }
  return { testPaths, shard };
};
