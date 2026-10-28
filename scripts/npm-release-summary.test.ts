import { expect, test } from "bun:test";

import { npmReleaseJobId } from "./generate-npm-release-jobs";
import { summarizeNpmRelease } from "./npm-release-summary";

const graph = [
  { directory: "base", dependencies: [] },
  { directory: "middle", dependencies: ["base"] },
  { directory: "consumer", dependencies: ["middle"] },
  { directory: "independent", dependencies: [] },
];

test("reports every selected package and the failed dependency behind each skip", () => {
  const report = summarizeNpmRelease({
    graph,
    selected: graph.map(({ directory }) => directory),
    results: {
      [npmReleaseJobId("base")]: "failure",
      [npmReleaseJobId("middle")]: "skipped",
      [npmReleaseJobId("consumer")]: "skipped",
      [npmReleaseJobId("independent")]: "success",
    },
  });
  expect(report.status).toBe("failed");
  expect(
    report.rows.map(({ directory, status }) => [directory, status]),
  ).toEqual([
    ["base", "failed"],
    ["middle", "skipped"],
    ["consumer", "skipped"],
    ["independent", "published"],
  ]);
  expect(
    report.rows.find(({ directory }) => directory === "middle")?.detail,
  ).toContain("@stll/base (failure)");
  expect(
    report.rows.find(({ directory }) => directory === "consumer")?.detail,
  ).toContain("@stll/middle (skipped)");
});

test("single-package dispatch ignores unselected skipped dependency jobs", () => {
  const report = summarizeNpmRelease({
    graph,
    selected: ["consumer"],
    results: {
      [npmReleaseJobId("base")]: "skipped",
      [npmReleaseJobId("middle")]: "skipped",
      [npmReleaseJobId("consumer")]: "success",
      [npmReleaseJobId("independent")]: "skipped",
    },
  });
  expect(report.status).toBe("passed");
  expect(report.rows).toHaveLength(1);
  expect(report.rows.at(0)).toMatchObject({
    directory: "consumer",
    status: "published",
  });
});

test.each(["failure", "cancelled", "skipped"] as const)(
  "a selected %s job fails the summary",
  (result) => {
    const report = summarizeNpmRelease({
      graph,
      selected: ["independent"],
      results: { [npmReleaseJobId("independent")]: result },
    });
    expect(report.status).toBe("failed");
    expect(report.rows.at(0)?.detail).not.toBe("");
  },
);

test("refuses a missing result, unknown package or duplicate selection", () => {
  expect(() =>
    summarizeNpmRelease({ graph, selected: ["consumer"], results: {} }),
  ).toThrow("Missing publish result for @stll/consumer");
  expect(() =>
    summarizeNpmRelease({ graph, selected: ["unknown"], results: {} }),
  ).toThrow("Unknown selected package");
  expect(() =>
    summarizeNpmRelease({ graph, selected: ["base", "base"], results: {} }),
  ).toThrow("Duplicate selected package");
});
