import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  MERGE_GROUP_PR_COVERAGE,
  type PlanScopeOutput,
  PR_COVERAGE_BASELINE,
} from "./ci-merge-group-pr-coverage";
import { type Context, evaluate } from "./github-expression";

const workflowSource = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const jobs = v.parse(
  v.object({ jobs: v.record(v.string(), v.unknown()) }),
  Bun.YAML.parse(workflowSource),
).jobs;
const condition = (job: unknown) =>
  v.parse(v.object({ if: v.optional(v.string()) }), job).if ?? "true";

const commonValues = {
  "github.event.pull_request.draft": false,
  "inputs.heavy_only": false,
  "inputs.pr_depth_only": false,
  "needs.ci-plan.result": "success",
  "needs.generated-sources.result": "success",
  "needs.pr-heavy-gate.result": "success",
  "needs.web-build.result": "success",
  "needs.heavy-web-build.result": "skipped",
  "needs.ci-plan.outputs.run_required": "true",
  "needs.ci-plan.outputs.pr_depth_reused": "false",
  "needs.ci-plan.outputs.pr_heavy_gate_required": "false",
  "needs.ci-plan.outputs.trusted": "true",
  "needs.ci-plan.outputs.coverage_profile": "pilot-fast-v1",
  "needs.ci-plan.outputs.pilot_fast_jobs":
    '["ci-browser","dependency-malware"]',
  "needs.ci-plan.outputs.suite_depth": "full",
  "needs.ci-plan.outputs.queue_depth": "full",
  "needs.ci-plan.outputs.heavy_proof": "false",
} as const;

const eventContext = (eventName: "merge_group" | "pull_request"): Context => ({
  values: {
    ...commonValues,
    "github.event_name": eventName,
    "needs.ci-plan.outputs.heavy_proof": String(eventName === "merge_group"),
    "needs.ci-plan.outputs.coverage_profile":
      eventName === "merge_group" ? "normal-v1" : "pilot-fast-v1",
  },
  status: { always: true, success: true, failure: false, cancelled: false },
});

const canRunInMergeGroup = (source: string) => {
  for (const status of [
    { always: true, success: true, failure: false, cancelled: false },
    { always: true, success: false, failure: true, cancelled: false },
  ]) {
    if (
      evaluate(source, { ...eventContext("merge_group"), status }) !== false
    ) {
      return true;
    }
  }
  return false;
};

const runsOnPullRequest = (source: string, scopeOutput: PlanScopeOutput) =>
  evaluate(source, {
    ...eventContext("pull_request"),
    values: {
      ...eventContext("pull_request").values,
      [`needs.ci-plan.outputs.${scopeOutput}`]: "true",
    },
  }) === true;

test("every parsed merge-group job has one PR coverage decision", () => {
  const parsed = Object.entries(jobs)
    .filter(([, job]) => canRunInMergeGroup(condition(job)))
    .map(([name]) => name)
    .toSorted();
  expect(Object.keys(MERGE_GROUP_PR_COVERAGE).toSorted()).toEqual(parsed);
});

test("runs-on-pr decisions are structurally reachable at their scope", () => {
  const baseline = new Set<string>(PR_COVERAGE_BASELINE);
  const violations = Object.entries(MERGE_GROUP_PR_COVERAGE).flatMap(
    ([name, coverage]) =>
      coverage.type === "runs-on-pr" &&
      !runsOnPullRequest(condition(jobs[name]), coverage.scopeOutput)
        ? [name]
        : [],
  );
  expect(violations.toSorted()).toEqual([...baseline].toSorted());
});

test("fixed merge-group jobs reject their former PR-only gaps", () => {
  const cases = [
    {
      name: "desktop-rust-tests",
      mutation: (source: string) =>
        source.replace(
          "(github.event_name == 'pull_request' || needs.ci-plan.outputs.heavy_proof == 'true')",
          "needs.ci-plan.outputs.heavy_proof == 'true'",
        ),
    },
    {
      name: "ci-browser",
      mutation: (source: string) =>
        `${source} && needs.ci-plan.outputs.coverage_profile == 'normal-v1'`,
    },
    {
      name: "e2e-production-shard",
      mutation: (source: string) =>
        `${source} && needs.ci-plan.outputs.coverage_profile == 'normal-v1'`,
    },
  ] as const;
  for (const { name, mutation } of cases) {
    const coverage = MERGE_GROUP_PR_COVERAGE[name];
    expect(coverage.type).toBe("runs-on-pr");
    if (coverage.type === "runs-on-pr") {
      const source = condition(jobs[name]);
      expect(runsOnPullRequest(source, coverage.scopeOutput), name).toBe(true);
      expect(
        runsOnPullRequest(mutation(source), coverage.scopeOutput),
        `${name} mutation`,
      ).toBe(false);
    }
  }
});

test("i18n PR coverage records current-base input drift", () => {
  expect(MERGE_GROUP_PR_COVERAGE["ci-checks-rest"]).toEqual({
    type: "runs-on-pr",
    scopeOutput: "package_checks_required",
    coupling: { type: "base-drift", reason: "current-base-i18n-inputs" },
  });
});
