import { panic } from "better-result";
import { readFileSync } from "node:fs";

import {
  API_TEST_SHARD_ENV,
  parseApiTestShard,
  partitionTestFiles,
} from "@stll/scripts/src/test-shard-planning";

export { API_TEST_SHARD_ENV, parseApiTestShard, partitionTestFiles };

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

type SelectApiTestFilesOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
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
  const testPaths = partitionTestFiles({
    files,
    durations,
    count: shard.count,
  }).at(shard.index - 1);
  if (testPaths === undefined || testPaths.length === 0) {
    panic(
      `API test shard ${shard.index}/${shard.count} selected zero test files`,
    );
  }
  return { testPaths, shard };
};
