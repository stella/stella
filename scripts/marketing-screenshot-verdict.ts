// Decides what a failed marketing screenshot check means.
//
// The check compares product screenshots with the committed baselines. A
// baseline that no longer matches is a report (the product changed), never a
// reason to fail a merge or a release: the step passes with a warning and the
// diff images stay in the uploaded artifact. Any other failure (a functional
// assertion, a timeout, a crashed page) keeps the check failing.
//
//   bun scripts/marketing-screenshot-verdict.ts <playwright-json-report> <playwright-exit-code>
import { panic } from "better-result";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

const ERROR = v.looseObject({ message: v.optional(v.string()) });
const RESULT = v.looseObject({
  status: v.string(),
  errors: v.optional(v.array(ERROR), []),
});
const TEST = v.looseObject({
  status: v.optional(v.string()),
  results: v.optional(v.array(RESULT), []),
});
const SPEC = v.looseObject({
  title: v.string(),
  tests: v.optional(v.array(TEST), []),
});
type Suite = {
  specs?: v.InferOutput<typeof SPEC>[];
  suites?: Suite[];
};
const SUITE: v.GenericSchema<Suite> = v.looseObject({
  specs: v.optional(v.array(SPEC)),
  suites: v.optional(v.array(v.lazy(() => SUITE))),
});
const REPORT = v.looseObject({
  suites: v.optional(v.array(SUITE), []),
  errors: v.optional(v.array(ERROR), []),
});

// Evidence of a real baseline difference: a pixel difference or a size
// mismatch against the committed image. A bare `toHaveScreenshot` failure
// (a page that never stabilised, a capture error) is not one.
const SCREENSHOT_MISMATCH =
  /\d+ pixels \(ratio [\d.]+ of all image pixels\) are different|Expected an image \d+px by \d+px, received \d+px by \d+px/u;

export type Verdict =
  | { kind: "pass" }
  | { kind: "screenshots-differ"; specs: string[] }
  | { kind: "fail"; reason: string };

const specsOf = (suites: readonly Suite[]): v.InferOutput<typeof SPEC>[] =>
  suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...specsOf(suite.suites ?? []),
  ]);

/** The verdict for a Playwright JSON report and the run's exit code. */
export const verdictOf = (report: unknown, exitCode: number): Verdict => {
  if (exitCode === 0) {
    return { kind: "pass" };
  }
  const parsed = v.safeParse(REPORT, report);
  if (!parsed.success) {
    return { kind: "fail", reason: "the Playwright report is unreadable" };
  }
  // A global error (setup, config, a crashed worker) is never a baseline diff.
  if (parsed.output.errors.length > 0) {
    return { kind: "fail", reason: "Playwright reported a global error" };
  }
  const differing: string[] = [];
  for (const spec of specsOf(parsed.output.suites)) {
    // Playwright's own outcome per test: "unexpected" covers a failure and an
    // expected failure that passed. Reports without it fall back to results.
    const unexpected = spec.tests.filter((test) =>
      test.status === undefined
        ? test.results.some(
            (result) =>
              result.status !== "passed" && result.status !== "skipped",
          )
        : test.status === "unexpected",
    );
    if (unexpected.length === 0) {
      continue;
    }
    const failed = unexpected.flatMap((test) =>
      test.results.filter(
        (result) => result.status !== "passed" && result.status !== "skipped",
      ),
    );
    if (
      unexpected.some((test) =>
        test.results.every((result) => result.status === "passed"),
      )
    ) {
      return {
        kind: "fail",
        reason: `${spec.title} passed although it was expected to fail`,
      };
    }
    const messages = failed.flatMap((result) =>
      result.errors.map((error) => error.message ?? ""),
    );
    if (
      failed.some((result) => result.status !== "failed") ||
      messages.length === 0 ||
      !messages.every((message) => SCREENSHOT_MISMATCH.test(message))
    ) {
      return {
        kind: "fail",
        reason: `${spec.title} failed for a reason other than a screenshot difference`,
      };
    }
    differing.push(spec.title);
  }
  return differing.length === 0
    ? {
        kind: "fail",
        reason: "Playwright exited non-zero without a failed test",
      }
    : { kind: "screenshots-differ", specs: differing };
};

if (import.meta.main) {
  const [reportPath, exitCodeText, ...extra] = process.argv.slice(2);
  const exitCode = Number(exitCodeText);
  if (
    reportPath === undefined ||
    !Number.isInteger(exitCode) ||
    extra.length > 0
  ) {
    panic(
      "usage: bun scripts/marketing-screenshot-verdict.ts <playwright-json-report> <playwright-exit-code>",
    );
  }
  const report: unknown = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf-8"))
    : undefined;
  const verdict = verdictOf(report, exitCode);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (verdict.kind === "pass") {
    process.exit(0);
  }
  if (verdict.kind === "screenshots-differ") {
    const text = `Marketing screenshots differ from the committed baselines (${verdict.specs.join(", ")}); the diff images are in this job's artifact. Refresh the baselines with the marketing screenshots update workflow.`;
    console.log(`::warning title=Marketing screenshots differ::${text}`);
    if (summary !== undefined) {
      appendFileSync(
        summary,
        `### Marketing screenshots\n\n${text}\n\nTODO: open the baseline refresh pull request automatically.\n`,
      );
    }
    process.exit(0);
  }
  console.log(
    `::error title=Marketing screenshot check failed::${verdict.reason}`,
  );
  process.exit(1);
}
