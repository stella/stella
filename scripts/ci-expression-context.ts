import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import type { ScopeOutput } from "./ci-plan-scope";
import { predicateVariables } from "./ci-plan-variables";

const MODELLED_EVENTS = [
  "merge_group",
  "pull_request",
  "push",
  "schedule",
  "workflow_dispatch",
] as const;
export type Event = (typeof MODELLED_EVENTS)[number];

/** A modelled event name, or a loud failure for an event the model lacks. */
export const modelledEvent = (value: string): Event =>
  MODELLED_EVENTS.find((event) => event === value) ??
  panic(`No modelled context for event ${value}`);

type RunContextOptions = {
  event?: Event;
  action?: string;
  heavyOnly?: boolean;
  prDepthOnly?: boolean;
  plan?: Record<string, string>;
  vars?: Record<string, string>;
  needsResults?: Record<string, string>;
  stepOutputs?: Record<string, Record<string, string>>;
};

type ModelledStep = {
  outputs: Record<string, string>;
  outcome?: string;
};

export type ModelledRunContext = {
  github: {
    event_name: Event;
    ref: string;
    sha: string;
    workflow_sha: string;
    repository: string;
    event: {
      action: string;
      head_commit: { message: string };
      pull_request: {
        draft: boolean;
        labels: { name: string }[];
        head: { repo: { full_name: string } };
      };
    };
  };
  inputs: Record<string, string | boolean> & {
    heavy_only: boolean;
    pr_depth_only: boolean;
    query_perf_mode: string;
    sha: string;
  };
  vars: Record<string, string> & {
    CI_POSTGRES_PR_SELECTION: string;
    CI_PR_DEPTH_PILOT: string;
    CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL: string;
    MERGE_QUEUE_DEPTH: string;
    QUEUE_BROWSER_SUITES: string;
  };
  steps: Record<string, ModelledStep>;
  needs: Record<string, { result: string; outputs: Record<string, string> }>;
  always: () => boolean;
  cancelled: () => boolean;
  failure: () => boolean;
  success: () => boolean;
  startsWith: (value: string, prefix: string) => boolean;
  format: (template: string, value: string) => string;
};

let variableDefaults: Record<string, string> | undefined;
const defaultVariables = () => {
  if (variableDefaults) {
    return variableDefaults;
  }
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        "ci-plan": v.object({ outputs: v.object({ variables: v.string() }) }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  variableDefaults = Object.fromEntries(
    predicateVariables(workflow.jobs["ci-plan"].outputs.variables).map(
      (name) => [name, ""],
    ),
  );
  return variableDefaults;
};

const REPOSITORY = "stella/stella";
const REF_BY_EVENT: Record<Event, string> = {
  merge_group: "refs/heads/gh-readonly-queue/main/pr-1-0000000",
  pull_request: "refs/pull/1/merge",
  push: "refs/heads/main",
  schedule: "refs/heads/main",
  workflow_dispatch: "refs/heads/main",
};

const DEFAULT_CHANGED_FILE_OUTPUTS = {
  api_scope_unknown: "false",
  agent_sandbox_docker_required: "false",
  api_image_deps_required: "false",
  api_image_platforms: "[]",
  api_image_smoke_required: "false",
  changed_files: "",
  ci_browser_scope_required: "false",
  collab_redis_required: "false",
  collaboration_suite_required: "false",
  comparison_base: "",
  corpus_suites_required: "false",
  database_migrations_required: "false",
  dependency_changes_required: "false",
  dependency_malware_required: "false",
  desktop_browser_required: "false",
  desktop_rust_checks_required: "false",
  desktop_windows_dry_run_required: "false",
  dev_seed_required: "false",
  docker_checks_pr_required: "false",
  docker_checks_required: "false",
  docs_changed_files: "",
  docs_checks_required: "false",
  e2e_core_required: "false",
  e2e_production_required: "false",
  e2e_landing_required: "false",
  fix_tests_on_base_required: "false",
  landing_build_required: "false",
  legal_atlas_image_pr_required: "false",
  legal_atlas_image_required: "false",
  lockfile_ages_required: "false",
  migration_rehearsal_required: "false",
  mobile_build_required: "false",
  model_catalog_drift_required: "false",
  package_checks_required: "false",
  postgres_suites_required: "false",
  published_exports_required: "false",
  release_typecheck_required: "false",
  route_smoke_required: "false",
  route_tree_required: "false",
  scan_engine_wasm_required: "false",
  service_suites_pr_required: "false",
  stack_redaction_browsers_required: "false",
  valkey_suites_required: "false",
  web_api_types_required: "false",
  web_build_required: "false",
  web_image_smoke_required: "false",
  windows_scripts_required: "false",
} satisfies Record<ScopeOutput, string>;

const PLAN_BOOLEAN_OUTPUTS = [
  ...Object.keys(DEFAULT_CHANGED_FILE_OUTPUTS).filter((name) =>
    name.endsWith("_required"),
  ),
  "browser_spec_selection_required",
  "ci_browser_required",
  "ci_tests_required",
  "heavy_web_build_required",
  "marketing_screenshots_required",
  "postgres_service_suites_required",
  "pr_heavy_gate_required",
  "query_perf_required",
  "service_suites_required",
  "web_build_pr_required",
];

const defaultPlan = () => ({
  ...Object.fromEntries(PLAN_BOOLEAN_OUTPUTS.map((name) => [name, "false"])),
  api_test_shards: "4",
  // The queue-only suites run (an armed run or a merge group); no armed delta.
  armed_delta: "false",
  coverage_profile: "normal-v1",
  heavy_proof: "true",
  pilot_fast_jobs: "[]",
  pr_depth_reused: "false",
  queue_depth: "full",
  run_required: "true",
  suite_depth: "full",
  trusted: "true",
});

const DEFAULT_STEP_OUTPUTS: Record<string, Record<string, string>> = {
  "api-test-durations": { hash: "", key: "" },
  "api-tests": {
    api_test_files: "[]",
    api_test_shards: "4",
    ci_tests_matrix: "[]",
    ci_tests_required: "true",
    test_scope: "",
  },
  "changed-files": DEFAULT_CHANGED_FILE_OUTPUTS,
  cached: { input_hash: "" },
  check: { trusted: "true" },
  "completed-depth": {
    plan_config: "fixture-plan-config",
    armed: "false",
    armed_proof: "",
    armed_proof_source_run_id: "",
    armed_proof_jobs: "[]",
    completed_run_id: "",
    marker: "",
    metadata_only: "false",
    normal_completion: "required",
    normal_source_run_id: "",
    pr_depth_reused: "false",
    pr_depth_source_run_id: "",
    pr_heavy_source_run_id: "",
    pr_heavy_source_sha: "",
    pr_heavy_suites: "run",
    queue_validation: "required",
    run_required: "true",
  },
  depth: { queue_depth: "full", suite_depth: "full" },
  "e2e-pr-plan": {
    matrix: "[]",
    mode: "none",
    required: "false",
    selection_required: "false",
    specs: "[]",
  },
  generate: { input_hash: "" },
  "heavy-plan": {
    heavy_jobs: "[]",
    queue_jobs: "[]",
    thin_jobs: "[]",
    armed_job_scopes: "{}",
  },
  images: {
    playwright: "",
    postgres: "",
    quickwit: "",
    redis: "",
    rustfs: "",
    valkey: "",
  },
  "legal-atlas-scope": { api_source_required: "false" },
  "marketing-release": { required: "false" },
  outcome: { required_summary: "" },
  "patch-id": {
    patch_id: "",
    workflow_version: "",
    tested_tree: "",
    workflow_tree: "",
  },
  "pilot-plan": { fast_jobs: "[]" },
  "pilot-queue-plan": { queue_jobs: "[]" },
  pilot: { coverage_profile: "normal-v1" },
  "postgres-test-durations": { hash: "" },
  "postgres-test-plan": {
    postgres_selection_reason: "",
    postgres_test_selection: "[]",
  },
  "pr-jobs-plan": { pr_depth_jobs: "[]", pr_heavy_jobs: "[]" },
  "query-perf-scope": { query_perf_required: "false" },
  "root-checks": { root_checks: "[]" },
  suites: { armed_delta: "false", run_required: "true", heavy_proof: "true" },
  "target-base": { base_sha: "" },
};

const NEEDS = [
  "ci-plan",
  "ci-tests",
  "e2e-production-shard",
  "e2e-vite-canary",
  "generated-sources",
  "heavy-web-build",
  "postgres-service-suites",
  "pr-heavy-gate",
  "web-build",
] as const;

/** Builds the complete GitHub expression context model used by CI contract tests. */
export const ciExpressionContext = ({
  event = "pull_request",
  action = "synchronize",
  heavyOnly = false,
  prDepthOnly = false,
  plan: planOverrides = {},
  vars = {},
  needsResults = {},
  stepOutputs = {},
}: RunContextOptions = {}): ModelledRunContext => {
  const plan = { ...defaultPlan(), ...planOverrides };
  const steps = Object.fromEntries(
    Object.entries(DEFAULT_STEP_OUTPUTS).map(([id, outputs]) => [
      id,
      { outputs: { ...outputs, ...stepOutputs[id] } },
    ]),
  );
  for (const [id, outputs] of Object.entries(stepOutputs)) {
    steps[id] ??= { outputs: { ...outputs } };
  }
  steps["changed-files"] = {
    outputs: { ...steps["changed-files"]?.outputs, ...planOverrides },
  };
  steps["completed-depth"] = {
    outputs: {
      ...steps["completed-depth"]?.outputs,
      run_required: plan.run_required,
    },
  };
  steps["suites"] = {
    outputs: {
      ...steps["suites"]?.outputs,
      heavy_proof:
        planOverrides["heavy_proof"] ??
        String(plan.run_required !== "false" && event !== "pull_request"),
    },
  };
  const modelledSteps: Record<string, ModelledStep> = {
    ...Object.fromEntries(
      Object.entries(steps).map(([id, step]) => [
        id,
        { outputs: step.outputs, outcome: "" },
      ]),
    ),
    ...Object.fromEntries(
      [
        "api-deps",
        "assert-cleanup",
        "canary",
        "cleanup",
        "image",
        "install",
        "isolation",
        "network",
        "protocol",
        "pull",
      ].map((id) => [id, { outputs: {}, outcome: "success" }]),
    ),
  };

  return {
    github: {
      event_name: event,
      ref: REF_BY_EVENT[event],
      sha: "",
      workflow_sha: "",
      event: {
        action,
        head_commit: { message: "ordinary" },
        // A same-repository pull request: fork-only paths stay unmodelled.
        pull_request: {
          draft: false,
          labels: [],
          head: { repo: { full_name: REPOSITORY } },
        },
      },
      repository: REPOSITORY,
    },
    inputs: {
      heavy_only: heavyOnly,
      pr_depth_only: prDepthOnly,
      query_perf_mode: "compare",
      sha: "",
    },
    vars: {
      ...defaultVariables(),
      CI_POSTGRES_PR_SELECTION: "",
      CI_PR_DEPTH_PILOT: "",
      CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL: "",
      MERGE_QUEUE_DEPTH: "",
      QUEUE_BROWSER_SUITES: "",
      ...vars,
    },
    steps: modelledSteps,
    needs: Object.fromEntries(
      [...new Set([...NEEDS, ...Object.keys(needsResults)])].map((job) => [
        job,
        {
          result: needsResults[job] ?? "success",
          outputs: job === "ci-plan" ? plan : {},
        },
      ]),
    ),
    always: () => true,
    cancelled: () => false,
    failure: () => false,
    success: () => true,
    startsWith: (value: string, prefix: string) =>
      value.toLowerCase().startsWith(prefix.toLowerCase()),
    format: (template: string, value: string) =>
      template.replace("{0}", () => value),
  };
};
