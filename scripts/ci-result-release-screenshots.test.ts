import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { renderResultInputs } from "./ci-result-inputs";

// ci-result's outcome step, run as CI runs it, for a merge group whose only
// failed job is the marketing screenshots check. Marketing screenshots never
// gate a release: in the release pull request's merge group a failure that
// is only the comparison passes with a warning naming the run. Every other
// failure, event or unreadable input keeps the group red.

const root = new URL("../", import.meta.url).pathname;
const StepSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        needs: v.optional(v.union([v.string(), v.array(v.string())])),
        steps: v.optional(v.array(StepSchema)),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  ),
);
const result = workflow.jobs["ci-result"];
const outcome = result?.steps?.find(
  ({ name }) => name === "Evaluate CI outcome",
);
if (!outcome?.run || !outcome.env || !Array.isArray(result?.needs)) {
  panic("Missing ci-result/Evaluate CI outcome");
}
const needs = result.needs;
const script = outcome.run;
const staticEnv = Object.fromEntries(
  Object.entries(outcome.env).filter(([, value]) => !value.includes("${{")),
);

const REPO = "stella/stella";
const RUN = 41_276_484_609;
const HEAD = "a".repeat(40);
const SCREENSHOTS = "marketing-screenshots";
const SCREENSHOTS_JOB = "marketing-screenshots / check";
const CAPTURE = "Capture marketing screenshots";
const MARKER = "Screenshot comparison failed";
const JOBS_ENDPOINT = `repos/${REPO}/actions/runs/${String(RUN)}/attempts/1/jobs?per_page=100`;
const checkRun = (id: number) =>
  `https://api.github.com/repos/${REPO}/check-runs/${String(id)}`;

// Answers `gh-retry.sh api ... <endpoint>` from a fixture map; any request
// without a fixture fails, as the API would.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
endpoint=""
for arg in "$@"; do
  case "$arg" in
    api | --paginate | --slurp) ;;
    *) endpoint=$arg ;;
  esac
done
jq -ce --arg key "$endpoint" '.[$key]' "$FIXTURES" || {
  echo "unexpected request: $endpoint" >&2
  exit 1
}
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const step = (name: string, conclusion: string) => ({ name, conclusion });
// The steps of merge-group run 41276484609's screenshots job: the capture
// failed after the comparison started.
const COMPARISON_FAILED = [
  step("Set up job", "success"),
  step("Require check mode", "success"),
  step("Checkout", "success"),
  step(CAPTURE, "failure"),
  step("Read screenshot comparison phase", "success"),
  step(MARKER, "success"),
  step("Upload failure diagnostics", "success"),
  step("Complete job", "success"),
];
// The capture failed before the comparison started (install, seed, migrate,
// API boot): the marker step is skipped.
const CAPTURE_FAILED = COMPARISON_FAILED.map((entry) =>
  entry.name === MARKER ? step(MARKER, "skipped") : entry,
);
const CHECKOUT_FAILED = COMPARISON_FAILED.map((entry) => {
  if (entry.name === "Checkout") {
    return step("Checkout", "failure");
  }
  return entry.name === CAPTURE || entry.name === MARKER
    ? step(entry.name, "skipped")
    : entry;
});

type Scenario = {
  event?: string;
  /** The plan's marketing_screenshots_advisory output; null omits it. */
  advisory?: string | null;
  /** The screenshots job's steps as the jobs API returns them. */
  steps?: unknown;
  /** Other jobs that failed beside the screenshots job. */
  alsoFailed?: readonly string[];
  /** Serve no job list, as when the jobs API is unavailable. */
  jobsUnavailable?: boolean;
  /** Leave the jq module directory unset. */
  modulesUnset?: boolean;
};

const runOutcome = ({
  event = "merge_group",
  advisory = "true",
  steps = COMPARISON_FAILED,
  alsoFailed = [],
  jobsUnavailable = false,
  modulesUnset = false,
}: Scenario) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-result-screenshots-"));
  directories.push(directory);
  const gh = path.join(directory, "gh-retry.sh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const failed = [SCREENSHOTS, ...alsoFailed];
  const jobs = [
    { name: "ci-plan", conclusion: "success", steps: [] },
    ...failed.map((job, index) => ({
      name: job === SCREENSHOTS ? SCREENSHOTS_JOB : job,
      conclusion: "failure",
      html_url: `https://github.com/${REPO}/actions/runs/${String(RUN)}/job/${String(index)}`,
      check_run_url: checkRun(1000 + index),
      steps: job === SCREENSHOTS ? steps : [step("Run the suite", "failure")],
    })),
    { name: "ci-result", status: "in_progress", conclusion: null, steps: [] },
  ];
  const fixtures: Record<string, unknown> = jobsUnavailable
    ? {}
    : { [JOBS_ENDPOINT]: [{ total_count: jobs.length, jobs }] };
  for (const index of failed.keys()) {
    fixtures[`${checkRun(1000 + index)}/annotations?per_page=100`] = [
      [{ message: "Process completed with exit code 1." }],
    ];
  }
  const fixtureFile = path.join(directory, "fixtures.json");
  writeFileSync(fixtureFile, JSON.stringify(fixtures));
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  const summary = path.join(directory, "summary");
  writeFileSync(summary, "");
  const plan: Record<string, string> = {
    marketing_screenshots_required: "true",
    heavy_proof: "true",
    suite_depth: "full",
    trusted: "true",
  };
  if (advisory !== null) {
    plan["marketing_screenshots_advisory"] = advisory;
  }
  const needsResults = Object.fromEntries(
    needs.map((job) => [
      job,
      { result: failed.includes(job) ? "failure" : "success", outputs: {} },
    ]),
  );
  const rendered = renderResultInputs(script, {
    needs: JSON.stringify(needsResults),
    plan: JSON.stringify(plan),
  });
  const child = Bun.spawnSync(
    ["bash", "-e", "-o", "pipefail", "-c", rendered],
    {
      timeout: 60_000,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        GITHUB_WORKFLOW: "CI Checks",
        TMPDIR: directory,
        RUNNER_TEMP: directory,
        ...staticEnv,
        EVENT: event,
        PR_NUMBER: event === "pull_request" ? "7732" : "",
        REPO,
        HEAD_SHA: HEAD,
        BASE_SHA: "b".repeat(40),
        GITHUB_RUN_ID: String(RUN),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GH_RETRY_SCRIPT: gh,
        FIXTURES: fixtureFile,
        ...(modulesUnset ? {} : { JQ_MODULES: path.join(root, "scripts") }),
        PLAN_RESULT: "success",
        RUN_REQUIRED: "true",
        TRUSTED: "true",
        HEAVY_PROOF: "true",
        SUITE_DEPTH: "full",
        QUEUE_DEPTH: "full",
        QUEUE_VALIDATION: "false",
        METADATA_ONLY: "false",
        PR_ACTION: "synchronize",
        PR_DEPTH_REUSED: "false",
        PR_HEAVY_SUITES: "run",
        COVERAGE_PROFILE: "normal-v1",
        HEAVY_ONLY: "false",
        PR_DEPTH_ONLY: "false",
      },
    },
  );
  const record = readFileSync(output, "utf-8")
    .split("\n")
    .find((line) => line.startsWith("required_summary="));
  return {
    exitCode: child.exitCode,
    log: child.stdout.toString() + child.stderr.toString(),
    summary: readFileSync(summary, "utf-8"),
    verdict: record
      ? v.parse(
          v.looseObject({ verdict: v.string() }),
          JSON.parse(record.slice("required_summary=".length)),
        ).verdict
      : undefined,
  };
};

const RUN_URL = `https://github.com/${REPO}/actions/runs/${String(RUN)}`;

test("a release pull request's merge group passes a comparison-only screenshot failure with a warning naming the run", () => {
  const run = runOutcome({});
  expect(run.exitCode, run.log).toBe(0);
  expect(run.log).toContain("::warning::Marketing screenshots never gate");
  expect(run.log).toContain(RUN_URL);
  expect(run.summary).toContain(RUN_URL);
  expect(run.verdict).toBe("success");
});

test("a merge group that is not a release pull request's keeps the screenshot comparison required", () => {
  const run = runOutcome({ advisory: "false" });
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).toContain(
    "CI checks did not succeed: marketing-screenshots (planned, failure)",
  );
  expect(run.verdict).toBe("failure");
});

test("a pull request run keeps the screenshot comparison required", () => {
  const run = runOutcome({ event: "pull_request" });
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).not.toContain("never gate");
});

test("a release merge group still blocks a screenshot failure before the comparison", () => {
  for (const [label, steps] of [
    ["capture without the comparison marker", CAPTURE_FAILED],
    ["checkout", CHECKOUT_FAILED],
    ["no steps", []],
    ["steps unreadable", "unreadable"],
  ] as const) {
    const run = runOutcome({ steps });
    expect(run.exitCode, `${label}: ${run.log}`).toBe(1);
    expect(run.log, label).not.toContain("never gate");
    expect(run.verdict, label).toBe("failure");
  }
});

test("a release merge group blocks when another job failed beside the screenshots", () => {
  const run = runOutcome({ alsoFailed: ["e2e-production-shard"] });
  expect(run.exitCode, run.log).toBe(1);
  expect(run.log).not.toContain("never gate");
});

test("an unreadable classification, job list or predicate blocks", () => {
  for (const [label, scenario] of [
    ["plan output missing", { advisory: null }],
    ["plan output empty", { advisory: "" }],
    ["job list unavailable", { jobsUnavailable: true }],
    ["predicate module missing", { modulesUnset: true }],
  ] as const) {
    const run = runOutcome(scenario);
    expect(run.exitCode, `${label}: ${run.log}`).toBe(1);
    expect(run.log, label).not.toContain("never gate");
  }
});

test("every workflow that applies the comparison predicate ships its module", () => {
  const fetchTooling = result.steps?.find(
    ({ name }) => name === "Fetch GitHub API tooling",
  );
  const preserve = result.steps?.find(
    ({ name }) =>
      name === "Preserve GitHub API tooling across source checkouts",
  );
  const sparse = v.parse(
    v.object({ with: v.object({ "sparse-checkout": v.string() }) }),
    fetchTooling,
  ).with["sparse-checkout"];
  expect(sparse.split("\n")).toContain(
    "scripts/marketing-screenshots-comparison.jq",
  );
  expect(preserve?.run).toContain("marketing-screenshots-comparison.jq");
  expect(preserve?.run).toContain("JQ_MODULES=$RUNNER_TEMP/jq-modules");
  // The release gate copies its sparse tooling, verdict filter included.
  const release = readFileSync(
    path.join(root, ".github/workflows/release.yml"),
    "utf-8",
  );
  expect(release).toContain("scripts/release-heavy-verdict.jq");
  expect(release).toContain("scripts/marketing-screenshots-comparison.jq");
  expect(
    readFileSync(path.join(root, "scripts/release-heavy-verdict.jq"), "utf-8"),
  ).toContain('include "marketing-screenshots-comparison" {search: "./"};');
});
