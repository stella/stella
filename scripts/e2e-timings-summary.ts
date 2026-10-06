import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

// Project only the timing fields; Playwright reports also contain diagnostics.
const reportSchema = v.object({
  config: v.object({ rootDir: v.string() }),
  suites: v.array(v.unknown()),
});
const suiteSchema = v.object({
  title: v.string(),
  suites: v.optional(v.array(v.unknown()), []),
  specs: v.array(
    v.object({
      title: v.string(),
      file: v.string(),
      line: v.number(),
      column: v.number(),
      tests: v.array(
        v.object({
          projectName: v.string(),
          results: v.array(
            v.object({
              duration: v.pipe(v.number(), v.finite(), v.minValue(0)),
            }),
          ),
        }),
      ),
    }),
  ),
});

type TestTiming = {
  file: string;
  title: string;
  project: string;
  milliseconds: number;
  attempts: number;
};

/** Attempt totals include failed attempts and retries, never parallel wall time. */
export const summarizeE2eTimings = (reports: readonly unknown[]) => {
  const tests = new Map<string, TestTiming>();
  for (const value of reports) {
    const report = v.parse(reportSchema, value);
    const visit = (suiteValue: unknown, ancestors: readonly string[]): void => {
      const suite = v.parse(suiteSchema, suiteValue);
      const titles = [...ancestors, suite.title];
      for (const spec of suite.specs) {
        const file = path.resolve(report.config.rootDir, spec.file);
        for (const test of spec.tests) {
          const key = JSON.stringify([
            file,
            spec.line,
            spec.column,
            test.projectName,
            titles,
            spec.title,
          ]);
          const timing = tests.get(key) ?? {
            file,
            title: [...titles, spec.title].join(" › "),
            project: test.projectName,
            milliseconds: 0,
            attempts: 0,
          };
          timing.milliseconds += test.results.reduce(
            (total, result) => total + result.duration,
            0,
          );
          timing.attempts += test.results.length;
          tests.set(key, timing);
        }
      }
      for (const nested of suite.suites) {
        visit(nested, titles);
      }
    };
    for (const suite of report.suites) {
      visit(suite, []);
    }
  }
  const sorted = [...tests.values()].toSorted(
    (a, b) =>
      b.milliseconds - a.milliseconds ||
      compareCodeUnit(JSON.stringify(a), JSON.stringify(b)),
  );
  const files = new Map<string, number>();
  for (const test of sorted) {
    files.set(test.file, (files.get(test.file) ?? 0) + test.milliseconds);
  }
  return {
    files: [...files]
      .map(([file, milliseconds]) => ({ file, milliseconds }))
      .toSorted(
        (a, b) =>
          b.milliseconds - a.milliseconds || compareCodeUnit(a.file, b.file),
      ),
    tests: sorted,
  };
};

export const formatE2eTimings = (
  summary: ReturnType<typeof summarizeE2eTimings>,
) =>
  [
    "Per-file attempt totals (seconds; overlapping workers are summed):",
    ...summary.files.map(
      ({ file, milliseconds }) =>
        `${(milliseconds / 1000).toFixed(3)}\t${file}`,
    ),
    "\nSlowest tests (seconds across all attempts):",
    ...summary.tests
      .slice(0, 20)
      .map(
        ({ file, title, project, milliseconds, attempts }) =>
          `${(milliseconds / 1000).toFixed(3)}\t${file}\t[${project}] ${title}\t${attempts} attempts`,
      ),
  ].join("\n");

if (import.meta.main) {
  const reports = process.argv.slice(2);
  if (reports.length === 0) {
    panic("Usage: bun scripts/e2e-timings-summary.ts <report.json>...");
  }
  console.log(
    formatE2eTimings(
      summarizeE2eTimings(
        reports.map((file): unknown => JSON.parse(readFileSync(file, "utf-8"))),
      ),
    ),
  );
}
