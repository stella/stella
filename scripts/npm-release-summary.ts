import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { readNpmReleaseGraph } from "./generate-npm-release-jobs";
import { npmReleaseJobId } from "./publish-packages";

type ReleaseJobResult = "success" | "failure" | "skipped" | "cancelled";
type ReleaseSummaryOptions = {
  graph: ReturnType<typeof readNpmReleaseGraph>;
  selected: readonly string[];
  results: Readonly<Record<string, ReleaseJobResult>>;
};

export const summarizeNpmRelease = ({
  graph,
  selected,
  results,
}: ReleaseSummaryOptions) => {
  const known = new Set(graph.map(({ directory }) => directory));
  assert.equal(
    new Set(selected).size,
    selected.length,
    "Duplicate selected package",
  );
  assert.ok(
    selected.every((directory) => known.has(directory)),
    "Unknown selected package",
  );
  const rows = graph
    .filter(({ directory }) => selected.includes(directory))
    .map(({ directory, dependencies }) => {
      const result = results[npmReleaseJobId(directory)];
      assert.ok(result, `Missing publish result for @stll/${directory}`);
      switch (result) {
        case "success":
          return {
            directory,
            status: "published" as const,
            detail: "Pinned publishing transaction succeeded.",
          };
        case "failure":
          return {
            directory,
            status: "failed" as const,
            detail:
              "Pinned publishing transaction failed; see this package's job logs for the error.",
          };
        case "cancelled":
          return {
            directory,
            status: "failed" as const,
            detail: "Publishing transaction was cancelled.",
          };
        case "skipped": {
          const blocked = dependencies.filter(
            (dependency) =>
              selected.includes(dependency) &&
              results[npmReleaseJobId(dependency)] !== "success",
          );
          return {
            directory,
            status: "skipped" as const,
            detail:
              blocked.length === 0
                ? "Selected publishing transaction did not run."
                : `Selected dependencies did not publish: ${blocked
                    .map((dependency) => {
                      const dependencyResult =
                        results[npmReleaseJobId(dependency)];
                      assert.ok(
                        dependencyResult,
                        `Missing publish result for @stll/${dependency}`,
                      );
                      return `@stll/${dependency} (${dependencyResult})`;
                    })
                    .join(", ")}.`,
          };
        }
        default:
          result satisfies never;
          throw new assert.AssertionError({
            message: "Unhandled release result",
          });
      }
    });
  return {
    rows,
    status: rows.every(({ status }) => status === "published")
      ? ("passed" as const)
      : ("failed" as const),
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isJobResult = (value: unknown): value is ReleaseJobResult =>
  value === "success" ||
  value === "failure" ||
  value === "skipped" ||
  value === "cancelled";

if (import.meta.main) {
  // The summary has read-only contents permission and receives no release
  // credentials. All publishing outcomes come from GitHub's needs context.
  try {
    const needs: unknown = JSON.parse(process.env["NPM_RELEASE_NEEDS"] ?? "");
    assert.ok(record(needs), "Missing release job results");
    const pack = needs["pack"];
    assert.ok(
      record(pack) && pack["result"] === "success" && record(pack["outputs"]),
      "Build and pack did not produce a package selection",
    );
    const selection = pack["outputs"]["packages"];
    assert.ok(
      typeof selection === "string",
      "Missing packed package selection",
    );
    const selected: unknown = JSON.parse(selection);
    assert.ok(
      Array.isArray(selected) &&
        selected.every((entry): entry is string => typeof entry === "string"),
      "Invalid packed package selection",
    );
    assert.ok(selected.length > 0, "No packages selected for publication");
    const results = Object.fromEntries(
      Object.entries(needs).map(([id, job]) => {
        assert.ok(
          record(job) && isJobResult(job["result"]),
          `Invalid result for ${id}`,
        );
        return [id, job["result"]] as const;
      }),
    );
    const root = path.resolve(import.meta.dirname, "..");
    const graph = readNpmReleaseGraph({
      readManifest: (directory) =>
        readFileSync(
          path.join(root, "packages", directory, "package.json"),
          "utf-8",
        ),
    });
    const report = summarizeNpmRelease({ graph, selected, results });
    const table = [
      "| Package | Outcome | Detail |",
      "| --- | --- | --- |",
      ...report.rows.map(
        ({ directory, status, detail }) =>
          `| @stll/${directory} | ${status} | ${detail} |`,
      ),
    ].join("\n");
    console.log(table);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) {
      appendFileSync(summary, `${table}\n`);
    }
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(
      `npm-release-summary: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
