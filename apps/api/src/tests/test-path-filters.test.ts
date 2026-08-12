import { describe, expect, test } from "bun:test";

import {
  isTestPathFilter,
  partitionRunnerArguments,
  selectTestPaths,
} from "../../scripts/test-path-filters";

const TEST_PATHS = [
  "src/lib/redis-outage.test.ts",
  "src/lib/sse-publish-timeout.test.ts",
  "src/handlers/workspaces/get.test.ts",
] as const;

describe("partitionRunnerArguments", () => {
  test("routes path arguments to the selector and everything else to bun", () => {
    const { bunArguments, pathFilters } = partitionRunnerArguments([
      "--bail",
      "-t",
      "publishes",
      "src/lib/sse-publish-timeout.test.ts",
    ]);

    // `publishes` is a `-t` value, not a file: forwarding it as a filter would
    // silently run nothing, and treating it as a path would drop the pattern.
    expect(bunArguments).toEqual(["--bail", "-t", "publishes"]);
    expect(pathFilters).toEqual(["src/lib/sse-publish-timeout.test.ts"]);
  });

  test("treats a bare directory as a path filter", () => {
    expect(isTestPathFilter("src/handlers")).toBe(true);
    expect(isTestPathFilter("get.test.ts")).toBe(true);
    expect(isTestPathFilter("--isolate")).toBe(false);
    expect(isTestPathFilter("publishes")).toBe(false);
  });
});

describe("selectTestPaths", () => {
  // The regression this guards: with no filter the runner must run each batch
  // whole. Returning an empty selection instead would silently run nothing.
  test("returns null when no filter is given, meaning run everything", () => {
    expect(selectTestPaths(TEST_PATHS, [])).toBeNull();
  });

  test("selects only discovered files, never adding the filter itself", () => {
    const selected = selectTestPaths(TEST_PATHS, [
      "./src/lib/sse-publish-timeout.test.ts",
    ]);

    // A leading `./` is how a shell completes a path; it must still match, and
    // the result must be the discovered path, since a batch is filtered by
    // identity against it.
    expect([...(selected ?? [])]).toEqual([
      "src/lib/sse-publish-timeout.test.ts",
    ]);
  });

  test("matches a directory prefix across files, as bun does", () => {
    expect([...(selectTestPaths(TEST_PATHS, ["src/lib/"]) ?? [])]).toEqual([
      "src/lib/redis-outage.test.ts",
      "src/lib/sse-publish-timeout.test.ts",
    ]);
  });

  test("selects nothing for a filter matching no discovered file", () => {
    expect(selectTestPaths(TEST_PATHS, ["src/nope/absent.test.ts"])?.size).toBe(
      0,
    );
  });
});
