import { describe, expect, test } from "bun:test";

import {
  partitionRunnerArguments,
  selectTestPaths,
} from "../../scripts/test-path-filters";

const TEST_PATHS = [
  "src/lib/redis-outage.test.ts",
  "src/lib/sse-publish-timeout.test.ts",
  "src/handlers/workspaces/get.test.ts",
] as const;

describe("partitionRunnerArguments", () => {
  test("keeps a value-taking flag's value with the flag, however it looks", () => {
    // Both values are shaped like the things they are not: one like a path,
    // one containing a slash. Classifying by shape would steal them from bun
    // and then select nothing.
    const { bunArguments, patterns } = partitionRunnerArguments([
      "--reporter-outfile",
      "reports/api.xml",
      "-t",
      "GET /workspaces",
    ]);

    expect(bunArguments).toEqual([
      "--reporter-outfile",
      "reports/api.xml",
      "-t",
      "GET /workspaces",
    ]);
    expect(patterns).toEqual([]);
  });

  test("treats a bare positional as a pattern, as bun does", () => {
    // `bun test redis-outage` is the ordinary way to run one file. Leaving it
    // to bun would append it to every batch and defeat the isolation.
    const { bunArguments, patterns } = partitionRunnerArguments([
      "redis-outage",
    ]);

    expect(bunArguments).toEqual([]);
    expect(patterns).toEqual(["redis-outage"]);
  });

  test("takes an optional numeric value only when it is a number", () => {
    expect(partitionRunnerArguments(["--bail", "3"])).toEqual({
      bunArguments: ["--bail", "3"],
      patterns: [],
    });
    expect(partitionRunnerArguments(["--bail", "redis-outage"])).toEqual({
      bunArguments: ["--bail"],
      patterns: ["redis-outage"],
    });
  });

  test("passes valueless and inline-value flags through untouched", () => {
    const { bunArguments, patterns } = partitionRunnerArguments([
      "--isolate",
      "--timeout=5000",
      "src/lib",
    ]);

    expect(bunArguments).toEqual(["--isolate", "--timeout=5000"]);
    expect(patterns).toEqual(["src/lib"]);
  });

  test("treats everything after -- as a pattern", () => {
    const { bunArguments, patterns } = partitionRunnerArguments([
      "--",
      "-t",
      "redis-outage",
    ]);

    expect(bunArguments).toEqual(["--"]);
    expect(patterns).toEqual(["-t", "redis-outage"]);
  });
});

describe("selectTestPaths", () => {
  // The regression this guards: with no pattern the runner must run each batch
  // whole. Returning an empty selection instead would silently run nothing.
  test("returns null when no pattern is given, meaning run everything", () => {
    expect(selectTestPaths(TEST_PATHS, [])).toBeNull();
  });

  test("matches a bare name as a substring of the path", () => {
    expect([...(selectTestPaths(TEST_PATHS, ["redis-outage"]) ?? [])]).toEqual([
      "src/lib/redis-outage.test.ts",
    ]);
  });

  test("selects only discovered files, never adding the pattern itself", () => {
    // A leading `./` is how a shell completes a path; it must still match, and
    // the result must be the discovered path, since a batch is filtered by
    // identity against it.
    const selected = selectTestPaths(TEST_PATHS, [
      "./src/lib/sse-publish-timeout.test.ts",
    ]);

    expect([...(selected ?? [])]).toEqual([
      "src/lib/sse-publish-timeout.test.ts",
    ]);
  });

  test("matches a directory prefix across files", () => {
    expect([...(selectTestPaths(TEST_PATHS, ["src/lib/"]) ?? [])]).toEqual([
      "src/lib/redis-outage.test.ts",
      "src/lib/sse-publish-timeout.test.ts",
    ]);
  });

  test("selects nothing for a pattern matching no discovered file", () => {
    expect(selectTestPaths(TEST_PATHS, ["src/nope/absent.test.ts"])?.size).toBe(
      0,
    );
  });
});
