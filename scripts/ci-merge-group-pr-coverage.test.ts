import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  MERGE_GROUP_PR_COVERAGE,
  type PlanScopeOutput,
  PR_COVERAGE_BASELINE,
  PR_PLAN_COVERAGE_BASELINE,
} from "./ci-merge-group-pr-coverage";
import { computeChangedFileScope, DEFAULT_DETECTORS } from "./ci-plan-scope";
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

test("ci-browser keeps the successful PR heavy-gate prerequisite", () => {
  const job = v.parse(
    v.object({ needs: v.array(v.string()), if: v.string() }),
    jobs["ci-browser"],
  );
  expect(job.needs).toEqual(["ci-plan", "pr-heavy-gate"]);
  expect(job.if).toContain(
    "(github.event_name != 'pull_request' || needs.pr-heavy-gate.result == 'success')",
  );
});

const REPRESENTATIVE_PLAN_FIXTURES = [
  ["apps/api/src/server.ts"],
  ["apps/web/src/app/layout.tsx"],
  ["apps/desktop/src/mainview/App.tsx"],
  ["apps/landing/src/pages/index.astro"],
  ["apps/api/src/db/schema.ts"],
  ["bun.lock"],
  [".github/workflows/ci.yml"],
] as const;

// Each declared plan output contributes a path from its own selector surface;
// the shared fixtures above retain the cross-scope combinations used by the
// planner tests rather than reducing this to isolated happy paths.
const SCOPE_PLAN_FIXTURES = {
  agent_sandbox_docker_required: "apps/agent-sandbox/Dockerfile",
  api_image_deps_required: "apps/api/Dockerfile",
  api_image_smoke_required: "scripts/smoke-api-image.sh",
  ci_browser_required: "apps/desktop/src/mainview/App.tsx",
  ci_tests_required: "apps/api/src/server.ts",
  database_migrations_required: "apps/api/src/db/migrations/meta/_journal.json",
  dependency_changes_required: "bun.lock",
  dependency_malware_required: "bun.lock",
  desktop_rust_checks_required: "apps/desktop/src-tauri/src/lib.rs",
  desktop_windows_dry_run_required: "apps/desktop/src-tauri/Cargo.toml",
  docker_checks_required: "apps/api/Dockerfile",
  e2e_core_required: "apps/web/e2e/core/auth.spec.ts",
  e2e_landing_required: "apps/web/e2e/landing/home.spec.ts",
  e2e_production_required: "apps/web/e2e/core/auth.spec.ts",
  heavy_web_build_required: "apps/web/src/app/layout.tsx",
  landing_build_required: "apps/landing/src/pages/index.astro",
  legal_atlas_image_required: "apps/legal-atlas/Dockerfile",
  marketing_screenshots_required: "apps/landing/src/pages/index.astro",
  migration_rehearsal_required: "apps/api/src/db/migrations/meta/_journal.json",
  mobile_build_required: "apps/mobile/app.json",
  package_checks_required: "packages/ui/src/index.ts",
  postgres_service_suites_required: "apps/api/src/db/schema.ts",
  query_perf_required: "apps/api/src/db/schema.ts",
  release_typecheck_required: "VERSION",
  route_smoke_required: "apps/api/src/server.ts",
  run_required: ".github/workflows/ci.yml",
  scan_engine_wasm_required: "packages/scan-engine/src/lib.rs",
  service_suites_required: "apps/api/src/server.ts",
  stack_redaction_browsers_required: "apps/web/e2e/stack-redaction.spec.ts",
  web_build_pr_required: "apps/web/e2e/production/documents.spec.ts",
  web_image_smoke_required: "apps/web/Dockerfile",
  windows_scripts_required: "scripts/windows/setup.ps1",
} as const;

const PLAN_FIXTURES = [
  ...REPRESENTATIVE_PLAN_FIXTURES,
  ...Object.values(SCOPE_PLAN_FIXTURES).map((file) => [file] as const),
];

const scopePlan = (
  files: readonly string[],
  eventName: "pull_request" | "merge_group",
) =>
  computeChangedFileScope(
    {
      changedFiles: files,
      comparisonBase: "",
      scopeUnknown: false,
      eventName,
      suiteDepth: eventName === "pull_request" ? "fast" : "full",
      heavyOnly: false,
      prTitle: "",
    },
    DEFAULT_DETECTORS,
  );

const rawPlanOutput = (
  plan: ReturnType<typeof scopePlan>,
  output: PlanScopeOutput,
) => {
  if (output === "run_required") {
    return true;
  }
  if (output === "ci_browser_required") {
    return (
      plan.package_checks_required === "true" &&
      plan.ci_browser_scope_required === "true" &&
      plan.desktop_browser_required === "true"
    );
  }
  if (output === "web_build_pr_required") {
    return plan.web_build_required === "true";
  }
  if (output === "heavy_web_build_required") {
    return false;
  }
  if (
    output === "ci_tests_required" ||
    output === "query_perf_required" ||
    output === "service_suites_required"
  ) {
    return plan.package_checks_required === "true";
  }
  if (output === "postgres_service_suites_required") {
    return plan.postgres_suites_required === "true";
  }
  if (output === "marketing_screenshots_required") {
    return plan.landing_build_required === "true";
  }
  return plan[output] === "true";
};

// timeout: repository-backed selectors scan package and import graphs for both plans.
test("fast PR plans cover every full merge-group job scope", () => {
  const fixturePlans = PLAN_FIXTURES.map((files) => ({
    mergeGroup: scopePlan(files, "merge_group"),
    pullRequest: scopePlan(files, "pull_request"),
  }));
  const violations = Object.entries(MERGE_GROUP_PR_COVERAGE).flatMap(
    ([name, coverage]) => {
      if (coverage.type !== "runs-on-pr") {
        return [];
      }
      expect(SCOPE_PLAN_FIXTURES, name).toHaveProperty(coverage.scopeOutput);
      const uncovered = fixturePlans.some(
        ({ mergeGroup, pullRequest }) =>
          rawPlanOutput(mergeGroup, coverage.scopeOutput) &&
          !rawPlanOutput(pullRequest, coverage.scopeOutput),
      );
      return uncovered ? [name] : [];
    },
  );
  expect(violations.toSorted()).toEqual(
    [...PR_PLAN_COVERAGE_BASELINE].toSorted(),
  );
}, 15_000);

test("i18n PR coverage records current-base input drift", () => {
  expect(MERGE_GROUP_PR_COVERAGE["ci-checks-rest"]).toEqual({
    type: "runs-on-pr",
    scopeOutput: "package_checks_required",
    coupling: { type: "base-drift", reason: "current-base-i18n-inputs" },
  });
});
