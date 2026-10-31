import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { ciExpressionContext, modelledEvent } from "./ci-expression-context";
import { renderResultInputs } from "./ci-result-inputs";
import {
  contextFromNested,
  contextWithPlanOutputs,
  evaluate as evaluateExpression,
  UNKNOWN,
} from "./github-expression";
import {
  mainHeavyJobs,
  MERGE_GROUP_EXCEPTIONS,
  queueAdmittedJobs,
  thinJobs,
} from "./main-heavy-plan";

const root = new URL("../", import.meta.url).pathname;
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflowSchema = v.object({
  name: v.string(),
  "run-name": v.optional(v.string()),
  concurrency: v.optional(
    v.object({
      group: v.string(),
      "cancel-in-progress": v.union([v.boolean(), v.string()]),
    }),
  ),
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      outputs: v.optional(v.record(v.string(), v.string())),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(v.array(stepSchema)),
    }),
  ),
});
const readWorkflow = (name: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows", name), "utf-8"),
    ),
  );
const ci = readWorkflow("ci.yml");
const planOutputs = v.parse(
  v.record(v.string(), v.string()),
  ci.jobs["ci-plan"]?.outputs,
);
const THIN_JOBS = thinJobs(ci);
const main = readWorkflow("main-heavy.yml");
const heavy = mainHeavyJobs(ci);
const admitted = queueAdmittedJobs(ci);
const eventPolicy = v.parse(
  v.object({ jobs: v.record(v.string(), v.string()) }),
  JSON.parse(
    readFileSync(path.join(root, ".github/ci-event-policy.json"), "utf-8"),
  ),
).jobs;
const assertTestShardPartition = (workflow: typeof ci) => {
  expect(mainHeavyJobs(workflow), "ci-tests").toContain("ci-tests");
  expect(thinJobs(workflow)).not.toContain("ci-tests");
};

test("test shards follow the derived heavy partition and cannot retain a thin exception", () => {
  assertTestShardPartition(ci);
  const mutated = structuredClone(ci);
  const tests = mutated.jobs["ci-tests"];
  if (!tests?.if) {
    panic("Missing test shard condition");
  }
  tests.if = `inputs.heavy_only != true && (${tests.if})`;
  expect(() => assertTestShardPartition(mutated)).toThrow("ci-tests");
});

type StepOptions = { workflow: typeof ci; job: string; name: string };
const step = ({ workflow, job, name }: StepOptions) => {
  const found = workflow.jobs[job]?.steps?.find((item) => item.name === name);
  if (!found?.run) {
    panic(`Missing ${job}/${name} script`);
  }
  return { ...found, run: found.run };
};
const depth = step({
  workflow: ci,
  job: "ci-plan",
  name: "Resolve suite depth",
});
const outcome = step({
  workflow: ci,
  job: "ci-result",
  name: "Evaluate CI outcome",
});
const folded = v.parse(
  v.record(v.string(), v.record(v.string(), v.string())),
  JSON.parse(outcome.env?.["FOLDED_SUITES"] ?? ""),
);
const scopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(outcome.env?.["JOB_SCOPES"] ?? ""),
);
const needs = v.parse(v.array(v.string()), ci.jobs["ci-result"]?.needs);
const plan = {
  ...Object.fromEntries(
    [
      ...Object.values(scopes),
      ...Object.values(folded).flatMap(Object.values),
    ].flatMap((scope) => (scope === null ? [] : [[scope, "true"]])),
  ),
  ...Object.fromEntries(
    Object.values(
      v.parse(
        v.record(v.string(), v.string()),
        JSON.parse(outcome.env?.["FAST_JOB_SCOPES"] ?? ""),
      ),
    ).map((scope) => [scope, "true"]),
  ),
  desktop_browser_required: "true",
  ci_browser_scope_required: "true",
  // Scopes the quick-check parts select by inside their shared job.
  docs_checks_required: "true",
  legal_atlas_image_inputs_required: "true",
  legal_atlas_api_source_required: "true",
  agent_sandbox_docker_required: "true",
  api_image_deps_required: "true",
  run_required: "true",
  trusted: "true",
  coverage_profile: "normal-v1",
  pilot_fast_jobs: "[]",
  queue_required_jobs: "[]",
  suite_depth: "full",
  service_suites_pr_required: "false",
  postgres_suites_required: "true",
  corpus_suites_required: "false",
  fix_tests_on_base_required: "false",
  browser_spec_selection_required: "true",
  api_test_shards: "4",
  pr_depth_reused: "false",
};
const events = [
  { event: "merge_group", message: "ordinary" },
  { event: "pull_request", message: "ordinary" },
  { event: "push", message: "ordinary" },
  { event: "push", message: "chore: release v1.2.3" },
  { event: "schedule", message: "ordinary" },
  { event: "workflow_dispatch", message: "ordinary" },
];
type ContextOptions = {
  event: (typeof events)[number];
  variable: string;
  queueDepth: string;
  proveFix?: boolean;
  /** The QUEUE_BROWSER_SUITES repository variable; GitHub reads unset as ''. */
  queueBrowserSuites?: string;
};
const context = ({
  event: { event, message },
  variable,
  queueDepth,
  proveFix = false,
  queueBrowserSuites = "",
}: ContextOptions) => {
  const value = ciExpressionContext({
    event: modelledEvent(event),
    plan: {
      ...plan,
      heavy_proof: String(event !== "pull_request" || proveFix),
      armed_delta: "false",
      queue_depth: queueDepth,
      ...(event === "pull_request"
        ? { fix_tests_on_base_required: "true" }
        : {}),
    },
    vars: {
      MERGE_QUEUE_DEPTH: variable,
      QUEUE_BROWSER_SUITES: queueBrowserSuites,
      CI_POSTGRES_PR_SELECTION: "",
    },
    needsResults: Object.fromEntries(needs.map((job) => [job, "success"])),
  });
  value.github.event.head_commit.message = message;
  value.github.event.pull_request.labels = proveFix
    ? [{ name: "prove-fix" }]
    : [];
  value.steps = {
    "completed-depth": {
      outputs: {
        normal_completion: "required",
        run_required: value.needs["ci-plan"]?.outputs["run_required"] ?? "true",
        pr_heavy_suites: "run",
        armed: String(proveFix),
        armed_proof: "",
      },
    },
    "pilot-queue-plan": { outputs: { queue_jobs: "[]" } },
  };
  return value;
};
// Some cases pass partial contexts; read nested fields without assuming shape.
const field = (source: unknown, key: string): unknown =>
  typeof source === "object" && source !== null
    ? Reflect.get(source, key)
    : undefined;
// ci-plan's run_required comes from the completed-depth lookup; cases set it
// on the plan outputs, so the lookup reports the same value.
const syncLookup = (value: object) => {
  const outputs = field(
    field(field(value, "steps"), "completed-depth"),
    "outputs",
  );
  if (typeof outputs !== "object" || outputs === null) {
    return;
  }
  const runRequired = field(
    field(field(field(value, "needs"), "ci-plan"), "outputs"),
    "run_required",
  );
  Reflect.set(
    outputs,
    "run_required",
    typeof runRequired === "string" ? runRequired : "true",
  );
};
const selected = (condition: string | undefined, value: object) => {
  const expression = condition ?? "true";
  syncLookup(value);
  const result = evaluateExpression(
    expression,
    contextWithPlanOutputs({
      context: contextFromNested(value),
      outputs: planOutputs,
    }),
  );
  if (result === UNKNOWN) {
    panic(`Unresolved queue workflow expression: ${expression}`);
  }
  return Boolean(result);
};
test("computed browser planning retains trust and suite scopes across queue depths", () => {
  for (const event of events.filter(({ event: eventName }) =>
    ["pull_request", "merge_group", "push", "workflow_dispatch"].includes(
      eventName,
    ),
  )) {
    for (const queueDepth of ["full", "thin"]) {
      for (const suiteDepth of ["fast", "full"]) {
        for (const trusted of ["true", "false"]) {
          for (const runRequired of ["true", "false"]) {
            for (const desktopRequired of ["true", "false"]) {
              const value = context({
                event,
                variable: queueDepth,
                queueDepth,
              });
              const planner = value.needs["ci-plan"];
              if (!planner) {
                panic("Missing browser planner context");
              }
              Object.assign(planner.outputs, {
                trusted,
                run_required: runRequired,
                suite_depth: suiteDepth,
                desktop_browser_required: desktopRequired,
                // An all-planned fixture must not bypass the real expression.
                ci_browser_required: "true",
              });
              const expected =
                runRequired === "true" &&
                (trusted === "true" || event.event === "workflow_dispatch") &&
                (event.event === "pull_request"
                  ? desktopRequired === "true"
                  : suiteDepth === "full");
              expect(
                selected(ci.jobs["ci-browser"]?.if, value),
                JSON.stringify({
                  event,
                  queueDepth,
                  suiteDepth,
                  trusted,
                  runRequired,
                  desktopRequired,
                }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  }
});

test("fast merge-group browser admission follows the planned jobs until normal completion", () => {
  for (const normalCompletion of ["required", "complete"]) {
    for (const queuedBrowser of [false, true]) {
      const value = context({
        event: { event: "merge_group", message: "ordinary" },
        variable: "thin",
        queueDepth: "thin",
      });
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic("Missing browser planner context");
      }
      planner.outputs["suite_depth"] = "fast";
      value.steps["completed-depth"]!.outputs["normal_completion"] =
        normalCompletion;
      value.steps["pilot-queue-plan"]!.outputs["queue_jobs"] = JSON.stringify(
        queuedBrowser ? ["ci-browser"] : [],
      );
      expect(
        selected(ci.jobs["ci-browser"]?.if, value),
        JSON.stringify({ normalCompletion, queuedBrowser }),
      ).toBe(queuedBrowser && normalCompletion !== "complete");
    }
  }
});

const expectedRouteSelection = (value: ReturnType<typeof context>) => {
  const planner = value.needs["ci-plan"];
  if (!planner) {
    panic("Missing route smoke planner context");
  }
  return (
    value.github.event_name !== "pull_request" &&
    (value.github.event_name !== "merge_group" || !value.cancelled()) &&
    planner.outputs["trusted"] === "true" &&
    planner.outputs["route_smoke_required"] === "true" &&
    (value.needs["web-build"]?.result === "success" ||
      value.needs["heavy-web-build"]?.result === "success") &&
    (value.github.event_name === "merge_group" || value.inputs.heavy_only)
  );
};
type ExpectedPrSelectionOptions = {
  job: string;
  baseline: boolean;
  value: ReturnType<typeof context>;
};
const DECLARED_PR_PLAN_CHANGES = new Set([
  "ci-browser",
  "e2e-landing",
  "e2e-production-shard",
  "scan-engine-wasm-drift",
  "web-build",
]);
const expectedPrSelection = ({
  job,
  baseline,
  value,
}: ExpectedPrSelectionOptions) => {
  const disposition = eventPolicy[`ci.yml/${job}`];
  if (disposition === undefined) {
    panic(`Missing CI event disposition: ${job}`);
  }
  if (disposition === "armed") {
    return (
      value.needs["ci-plan"]?.outputs["heavy_proof"] === "true" &&
      (job === "e2e-report" ? baseline : true)
    );
  }
  if (job === "ci-browser") {
    expect(DECLARED_PR_PLAN_CHANGES.has(job)).toBe(true);
    // A PR runs the browser job for its desktop suite or for the UI
    // playground specs the planner selected from its changes.
    return (
      value.needs["ci-plan"]?.outputs["trusted"] === "true" &&
      (value.needs["ci-plan"].outputs["desktop_browser_required"] === "true" ||
        (value.needs["ci-plan"].outputs["ui_playground_specs"] ?? "[]") !==
          "[]")
    );
  }
  if (job === "scan-engine-wasm-drift") {
    expect(DECLARED_PR_PLAN_CHANGES.has(job)).toBe(true);
    return (
      value.needs["ci-plan"]?.outputs["trusted"] === "true" &&
      value.needs["ci-plan"].outputs["scan_engine_wasm_required"] === "true"
    );
  }
  if (job === "web-build") {
    expect(DECLARED_PR_PLAN_CHANGES.has(job)).toBe(true);
    return (
      !value.inputs.heavy_only &&
      value.needs["ci-plan"]?.outputs["trusted"] === "true" &&
      value.needs["ci-plan"].outputs["browser_spec_selection_required"] ===
        "true"
    );
  }
  // A landing change is checked in its own pull request, behind the gate.
  if (job === "e2e-landing") {
    expect(DECLARED_PR_PLAN_CHANGES.has(job)).toBe(true);
    return (
      value.needs["ci-plan"]?.outputs["run_required"] !== "false" &&
      value.needs["ci-plan"]?.outputs["trusted"] === "true" &&
      value.needs["ci-plan"].outputs["e2e_landing_required"] === "true" &&
      value.needs["ci-plan"].outputs["coverage_profile"] === "normal-v1" &&
      value.needs["pr-heavy-gate"]?.result === "success"
    );
  }
  if (job === "e2e-production-shard") {
    expect(DECLARED_PR_PLAN_CHANGES.has(job)).toBe(true);
    return (
      value.needs["ci-plan"]?.outputs["coverage_profile"] === "normal-v1" &&
      value.needs["ci-plan"].outputs["trusted"] === "true" &&
      value.needs["ci-plan"].outputs["e2e_production_required"] === "true" &&
      (value.needs["web-build"]?.result === "success" ||
        value.needs["heavy-web-build"]?.result === "success")
    );
  }
  switch (disposition) {
    // These contexts model unarmed pull requests.
    case "armed":
    case "queue":
    case "main":
      return false;
    case "pr-opt-in":
      return (
        value.github.event.pull_request.labels.some(
          (label) => label.name === "prove-fix",
        ) && baseline
      );
    // A schema PR job gates on its own planner output, like a fast PR job.
    case "schema-pr":
    case "pr-fast":
      return baseline;
    default:
      return panic(`Unexpected CI event disposition: ${job}/${disposition}`);
  }
};
// Postgres PR selection and corpus coverage are declared exceptions to the
// historical full-depth gate.
const expectedServiceSelection = (value: ReturnType<typeof context>) => {
  const outputs = value.needs["ci-plan"]?.outputs;
  if (!outputs) {
    panic("Missing Postgres planner context");
  }
  const event = value.github.event_name;
  return (
    outputs["run_required"] !== "false" &&
    (outputs["package_checks_required"] === "true" ||
      outputs["collab_redis_required"] === "true") &&
    (outputs["trusted"] === "true" || event === "workflow_dispatch") &&
    (outputs["corpus_suites_required"] === "true" ||
      ((event !== "pull_request" ||
        value.vars.CI_POSTGRES_PR_SELECTION === "on") &&
        (outputs["suite_depth"] === "full" ||
          (outputs["suite_depth"] === "fast" &&
            outputs["service_suites_pr_required"] === "true"))))
  );
};

const expectedPostgresSelection = (value: ReturnType<typeof context>) => {
  const outputs = value.needs["ci-plan"]?.outputs;
  if (!outputs) {
    panic("Missing Postgres planner context");
  }
  return (
    outputs["run_required"] !== "false" &&
    (outputs["trusted"] === "true" ||
      value.github.event_name === "workflow_dispatch") &&
    outputs["postgres_suites_required"] === "true" &&
    (value.github.event_name !== "pull_request" ||
      value.vars.CI_POSTGRES_PR_SELECTION === "on") &&
    (outputs["suite_depth"] === "full" ||
      (outputs["suite_depth"] === "fast" &&
        outputs["service_suites_pr_required"] === "true"))
  );
};

test("declared Postgres selection preserves every scope, depth, trust and PR opt-in gate", () => {
  for (const event of events) {
    for (const suiteDepth of ["full", "fast", "unknown"]) {
      for (const queueDepth of ["full", "thin"]) {
        for (const prSwitch of ["", "off", "on"]) {
          for (const trusted of ["true", "false"]) {
            for (const required of ["true", "false"]) {
              for (const prRequired of ["true", "false"]) {
                for (const runRequired of ["true", "false"]) {
                  const value = context({ event, variable: "", queueDepth });
                  value.vars.CI_POSTGRES_PR_SELECTION = prSwitch;
                  const planner = value.needs["ci-plan"];
                  if (!planner) {
                    panic("Missing Postgres planner context");
                  }
                  Object.assign(planner.outputs, {
                    suite_depth: suiteDepth,
                    trusted,
                    package_checks_required: required,
                    postgres_suites_required: required,
                    collab_redis_required: "false",
                    service_suites_pr_required: prRequired,
                    run_required: runRequired,
                  });
                  expect(
                    selected(ci.jobs["service-suites"]?.if, value),
                    JSON.stringify({
                      event,
                      suiteDepth,
                      queueDepth,
                      prSwitch,
                      trusted,
                      required,
                      prRequired,
                      runRequired,
                    }),
                  ).toBe(expectedServiceSelection(value));
                  expect(
                    selected(ci.jobs["postgres-service-suites"]?.if, value),
                  ).toBe(expectedPostgresSelection(value));
                }
              }
            }
          }
        }
      }
    }
  }
});

const templateValue = (template: string, value: object) =>
  template.replaceAll(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) =>
    String(
      v.parse(
        v.union([v.string(), v.number()]),
        new Script(`(${expression})`).runInNewContext(value),
      ),
    ),
  );

type ConcurrencyContextOptions = {
  event: (typeof events)[number];
  variable: string;
  eventSha: string;
  testedSha: string;
};
const concurrencyContext = ({
  event,
  variable,
  eventSha,
  testedSha,
}: ConcurrencyContextOptions) => {
  const value = context({ event, variable, queueDepth: "full" });
  return {
    ...value,
    github: {
      ...value.github,
      sha: eventSha,
      workflow: main.name,
      ref: "refs/heads/main",
      run_id: eventSha === "a".repeat(40) ? 1 : 2,
    },
    inputs: {
      ...value.inputs,
      sha: event.event === "workflow_dispatch" ? testedSha : "",
    },
    format: (template: string, sha: string) =>
      template.replace("{0}", () => sha),
  };
};

const cancellationValue = (cancel: boolean | string, value: object) =>
  typeof cancel === "boolean"
    ? cancel
    : v.parse(
        v.boolean(),
        new Script(
          cancel.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/u, "$1"),
        ).runInNewContext(value),
      );

const assertMainConcurrency = (workflow: typeof main) => {
  const concurrency = workflow.concurrency;
  const runName = workflow["run-name"];
  if (!concurrency || !runName) {
    panic("Main heavy workflow requires concurrency and a run name");
  }
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  for (const event of events.filter(({ event: eventName }) =>
    mainTriggered(eventName),
  )) {
    for (const variable of ["", "full", "thin"]) {
      const groups = [];
      for (const eventSha of [shaA, shaB]) {
        let testedSha = eventSha;
        if (event.event === "workflow_dispatch") {
          testedSha = eventSha === shaA ? shaB : shaA;
        }
        const value = concurrencyContext({
          event,
          variable,
          eventSha,
          testedSha,
        });
        const group = templateValue(concurrency.group, value);
        const cancel = concurrency["cancel-in-progress"];
        expect(
          cancellationValue(cancel, value),
          event.event === "workflow_dispatch" ||
            (event.event === "push" &&
              event.message.startsWith("chore: release v"))
            ? "release heavy work is preserved"
            : "superseded heavy work is cancelled",
        ).toBe(
          event.event !== "workflow_dispatch" &&
            !(
              event.event === "push" &&
              event.message.startsWith("chore: release v")
            ),
        );
        let expectedGroup = `${main.name}-refs/heads/main`;
        if (event.event === "workflow_dispatch") {
          expectedGroup = `${main.name}-release-${testedSha}`;
        } else if (
          event.event === "push" &&
          event.message.startsWith("chore: release v")
        ) {
          expectedGroup = `${main.name}-release-${eventSha}`;
        } else if (
          event.event === "push" &&
          !event.message.startsWith("chore: release v")
        ) {
          expectedGroup = `${main.name}-${value.github.run_id}`;
        }
        expect(group, `${event.event}/${event.message}/${variable}/group`).toBe(
          expectedGroup,
        );
        expect(
          templateValue(runName, value),
          `${event.event}/tested SHA title`,
        ).toBe(`Main heavy suites ${testedSha}`);
        groups.push(group);
      }
      const [first, second] = groups;
      if (event.event === "workflow_dispatch" || event.event === "push") {
        expect(first).not.toBe(second);
      } else {
        expect(first).toBe(second);
      }
      if (event.event === "workflow_dispatch") {
        const repeated = [shaA, shaB].map((eventSha) =>
          concurrencyContext({ event, variable, eventSha, testedSha: shaA }),
        );
        expect(
          templateValue(
            concurrency.group,
            repeated.at(0) ?? panic("Missing dispatch context"),
          ),
        ).toBe(
          templateValue(
            concurrency.group,
            repeated.at(1) ?? panic("Missing dispatch context"),
          ),
        );
        const unpinned = concurrencyContext({
          event,
          variable,
          eventSha: shaA,
          testedSha: "",
        });
        expect(
          templateValue(concurrency.group, unpinned),
          "unpinned dispatch shares the branch group",
        ).toBe(`${main.name}-refs/heads/main`);
        const cancel = concurrency["cancel-in-progress"];
        expect(
          cancellationValue(cancel, unpinned),
          "unpinned dispatch retains supersession",
        ).toBe(true);
      }
    }
  }
};

let baselineWorkflows: { ci: typeof ci; main: typeof main } | undefined;
const original = (name: "ci.yml" | "main-heavy.yml") => {
  if (baselineWorkflows) {
    return name === "ci.yml" ? baselineWorkflows.ci : baselineWorkflows.main;
  }
  const history = Bun.spawnSync(
    [
      "git",
      "log",
      "-n",
      "30",
      "--format=%H",
      "--",
      ".github/workflows/main-heavy.yml",
    ],
    { cwd: root },
  );
  expect(history.exitCode).toBe(0);
  for (const revision of history.stdout.toString().trim().split("\n")) {
    const priorMain = Bun.spawnSync(
      ["git", "show", `${revision}:.github/workflows/main-heavy.yml`],
      { cwd: root },
    );
    if (priorMain.exitCode !== 0) {
      continue;
    }
    const source = priorMain.stdout.toString();
    const parsed = v.parse(workflowSchema, Bun.YAML.parse(source));
    const validate = parsed.jobs["validate"]?.if;
    if (
      !source.includes("schedule:") ||
      !parsed.jobs["suites"]?.if ||
      !validate ||
      validate.includes("MERGE_QUEUE_DEPTH")
    ) {
      continue;
    }
    const priorCi = Bun.spawnSync(
      ["git", "show", `${revision}:.github/workflows/ci.yml`],
      { cwd: root },
    );
    expect(priorCi.exitCode).toBe(0);
    baselineWorkflows = {
      ci: v.parse(workflowSchema, Bun.YAML.parse(priorCi.stdout.toString())),
      main: parsed,
    };
    return name === "ci.yml" ? baselineWorkflows.ci : baselineWorkflows.main;
  }
  return panic(
    "No prior full-queue workflow baseline in bounded main-heavy history",
  );
};

const mainTriggered = (event: string) =>
  ["push", "schedule", "workflow_dispatch"].includes(event);
type MainSelectionOptions = {
  workflow: typeof main;
  event: (typeof events)[number];
  variable: string;
};
const mainSelection = ({ workflow, event, variable }: MainSelectionOptions) => {
  const value = context({ event, variable, queueDepth: "full" });
  const validationSelected =
    mainTriggered(event.event) &&
    selected(workflow.jobs["validate"]?.if, value);
  let validationResult = "skipped";
  if (validationSelected) {
    const validation = workflow.jobs["validate"]?.steps?.find(
      ({ name }) => name === "Validate merge queue depth",
    );
    const result = validation?.run
      ? Bun.spawnSync(["bash", "-e", "-c", validation.run], {
          cwd: root,
          env: { ...process.env, MERGE_QUEUE_DEPTH: variable },
        }).exitCode
      : 0;
    validationResult = result === 0 ? "success" : "failure";
  }
  const dependentContext = {
    ...value,
    needs: {
      validate: {
        result: validationResult,
        outputs: { run: "true", proof: "" },
      },
    },
  };
  const suites =
    mainTriggered(event.event) &&
    selected(workflow.jobs["suites"]?.if, dependentContext);
  const status =
    mainTriggered(event.event) &&
    selected(workflow.jobs["status"]?.if, dependentContext);
  return {
    validate: validationSelected,
    suites,
    status,
    publishes: status && validationResult === "success",
  };
};
const assertMainSelection = (workflow: typeof main) => {
  for (const event of events) {
    for (const variable of ["", "full", "thin", "typo"]) {
      const validationSelected =
        mainTriggered(event.event) &&
        (event.event !== "push" ||
          event.message.startsWith("chore: release v"));
      const valid = variable !== "typo";
      expect(
        mainSelection({ workflow, event, variable }),
        `${event.event}/${event.message}/${variable}`,
      ).toEqual({
        validate: validationSelected,
        suites: validationSelected && valid,
        status: validationSelected,
        publishes: validationSelected && valid,
      });
    }
  }
};

test("failure-only cancellation jobs resolve both successful and failed dependencies", () => {
  const cancellations = Object.entries(ci.jobs).filter(([, job]) =>
    job.if?.includes("failure()"),
  );
  expect(cancellations.length).toBeGreaterThan(0);
  for (const [id, job] of cancellations) {
    for (const event of events) {
      for (const failed of [false, true]) {
        const value = context({ event, variable: "full", queueDepth: "full" });
        value.failure = () => failed;
        const pullRequestHelper =
          id.endsWith("-cancel") && id.startsWith("code-quality-");
        expect(selected(job.if, value), `${id}/${event.event}/${failed}`).toBe(
          failed &&
            event.event ===
              (pullRequestHelper ? "pull_request" : "merge_group"),
        );
        if (
          event.event === (pullRequestHelper ? "pull_request" : "merge_group")
        ) {
          const unresolved = Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "failure"),
          );
          expect(() => selected(job.if, unresolved)).toThrow(
            "Unresolved queue workflow expression",
          );
        }
      }
    }
  }
});

test("route smoke certifies planned queue and heavy builds while skipping unarmed PRs", () => {
  expect(eventPolicy["ci.yml/route-smoke"]).toBe("armed");
  const cases = events
    .flatMap((event) =>
      ["full", "thin"].map((queueDepth) => ({ event, queueDepth })),
    )
    .flatMap((value) => [false, true].map((planned) => ({ ...value, planned })))
    .flatMap((value) => [false, true].map((trusted) => ({ ...value, trusted })))
    .flatMap((value) =>
      [false, true].map((cancelled) => ({ ...value, cancelled })),
    )
    .flatMap((value) =>
      [false, true].map((heavyOnly) => ({ ...value, heavyOnly })),
    )
    .flatMap((value) =>
      ["success", "skipped", "failure"].map((webResult) => ({
        ...value,
        webResult,
      })),
    )
    .flatMap((value) =>
      ["success", "skipped", "failure"].map((heavyResult) => ({
        ...value,
        heavyResult,
      })),
    );
  for (const scenario of cases) {
    const value = context({
      event: scenario.event,
      variable: "full",
      queueDepth: scenario.queueDepth,
    });
    const planner = value.needs["ci-plan"];
    const web = value.needs["web-build"];
    const heavyWeb = value.needs["heavy-web-build"];
    if (!planner || !web || !heavyWeb) {
      panic("Missing route smoke build context");
    }
    planner.outputs["route_smoke_required"] = String(scenario.planned);
    planner.outputs["trusted"] = String(scenario.trusted);
    value.inputs.heavy_only = scenario.heavyOnly;
    value.cancelled = () => scenario.cancelled;
    web.result = scenario.webResult;
    heavyWeb.result = scenario.heavyResult;
    expect(
      selected(ci.jobs["route-smoke"]?.if, value),
      JSON.stringify(scenario),
    ).toBe(expectedRouteSelection(value));
  }
});

test("unset and full preserve historical predicates except declared PR, Postgres, corpus and route ownership changes", () => {
  const baseline = original("ci.yml");
  const baselineMain = original("main-heavy.yml");
  expect(Object.keys(main.jobs)).toEqual(Object.keys(baselineMain.jobs));
  // Retired jobs: generated sources now come from the generated-sources job.
  const retiredJobs = new Set([
    "merge-group-fail-fast",
    "ci-generated-sources",
  ]);
  const collapsedJobs = new Map([
    ["code-quality-web", "code-quality-web-rest"],
    ["code-quality-rest", "code-quality-web-rest"],
    ["typecheck-baseline", "ci-checks-generated"],
    ["desktop-clippy", "desktop-rust-tests"],
  ]);
  // Jobs that became one part of a shared job: the part's step condition,
  // under the shared job's condition, keeps the historical predicate.
  const foldedParts = new Map([
    ["parser-version-guard", "pr-heavy-gate"],
    ["ci-checks-docs", "pr-heavy-gate"],
    ["dated-waiver-expiry", "pr-heavy-gate"],
  ]);
  const partSelected = (job: string, value: ReturnType<typeof context>) => {
    const host = foldedParts.get(job);
    if (host === undefined) {
      return selected(ci.jobs[collapsedJobs.get(job) ?? job]?.if, value);
    }
    const parts = (ci.jobs[host]?.steps ?? []).filter(({ name }) =>
      name?.startsWith(`${job}: `),
    );
    expect(parts.length, job).toBeGreaterThan(0);
    const installed = {
      ...value,
      steps: { ...value.steps, install: { outcome: "success" } },
    };
    return (
      selected(ci.jobs[host]?.if, installed) &&
      parts.every((part) => selected(part.if, installed))
    );
  };
  expect(Object.keys(ci.jobs).toSorted()).toEqual(
    [
      ...new Set([
        ...Object.keys(baseline.jobs).filter(
          (id) =>
            !retiredJobs.has(id) &&
            !collapsedJobs.has(id) &&
            !foldedParts.has(id),
        ),
        "api-test-durations",
        "generated-sources",
        "postgres-service-suites",
        "pr-heavy-gate",
        "marketing-screenshots-cancel",
        "code-quality-api-cancel",
        "code-quality-web-rest-cancel",
        "ci-quick-checks",
        "code-quality-web-rest",
        "desktop-rust-tests",
        "desktop-rust-lint",
        "query-perf",
        "scan-engine-wasm-drift",
        "dependency-audit",
        "dependency-review",
        "database-migrations-check",
        "database-migrations-apply-fresh",
      ]),
    ].toSorted(),
  );
  expect([...DECLARED_PR_PLAN_CHANGES].toSorted()).toEqual([
    "ci-browser",
    "e2e-landing",
    "e2e-production-shard",
    "scan-engine-wasm-drift",
    "web-build",
  ]);
  for (const event of events) {
    for (const { variable, proveFix } of ["", "full"].flatMap((queueVariable) =>
      [false, true].map((labelRequested) => ({
        variable: queueVariable,
        proveFix: labelRequested,
      })),
    )) {
      const value = context({ event, variable, queueDepth: "full", proveFix });
      for (const [job, body] of Object.entries(baseline.jobs)) {
        if (retiredJobs.has(job)) {
          continue;
        }
        let expected = selected(body.if, value);
        if (job === "docker-checks" && event.event === "merge_group") {
          expected =
            value.needs["ci-plan"]?.outputs["docker_checks_required"] ===
            "true";
        } else if (job === "service-suites") {
          expected = expectedServiceSelection(value);
        } else if (job === "postgres-service-suites") {
          expected = expectedPostgresSelection(value);
        } else if (job === "route-smoke" && event.event !== "pull_request") {
          expected = expectedRouteSelection(value);
        } else if (event.event === "pull_request") {
          expected = expectedPrSelection({
            job: collapsedJobs.get(job) ?? foldedParts.get(job) ?? job,
            baseline: expected,
            value,
          });
        }
        expect(
          partSelected(job, value),
          `${event.event}/${event.message}/${variable}/${proveFix}/${job}`,
        ).toBe(expected);
      }
    }
  }
}, 30_000);

test("merge groups certify the same scoped code jobs at both queue depths", () => {
  for (const job of admitted) {
    for (const queueBrowserSuites of ["", "on", "off"]) {
      const values = ["full", "thin"].map((queueDepth) =>
        context({
          event: { event: "merge_group", message: "ordinary" },
          variable: queueDepth,
          queueDepth,
          queueBrowserSuites,
        }),
      );
      const selections = values.map((value) =>
        selected(ci.jobs[job]?.if, value),
      );
      expect(selections, `${job}/${queueBrowserSuites}`).toEqual([true, true]);
    }
  }
  assertMainSelection(main);
});

type RunDepthOptions = { event: string; variable: string; heavyOnly?: boolean };
const runDepth = ({ event, variable, heavyOnly = false }: RunDepthOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "thin-depth-"));
  const output = path.join(directory, "output");
  writeFileSync(output, "");
  try {
    const result = Bun.spawnSync(["bash", "-e", "-c", depth.run], {
      cwd: root,
      env: {
        ...process.env,
        EVENT_NAME: event,
        MERGE_QUEUE_DEPTH: variable,
        DISPATCH_DEPTH: "full",
        // Full dispatches off main need allow_full; main is always allowed.
        DISPATCH_REF: "refs/heads/main",
        HEAVY_ONLY: String(heavyOnly),
        GITHUB_OUTPUT: output,
      },
    });
    return {
      exitCode: result.exitCode,
      output: readFileSync(output, "utf-8"),
      diagnostic: result.stdout.toString() + result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("the actual depth resolver fails closed and retains full suite scopes for thin queues", () => {
  expect(depth.env?.["MERGE_QUEUE_DEPTH"]).toBe(
    `\${{ vars.MERGE_QUEUE_DEPTH }}`,
  );
  for (const { event } of events) {
    for (const variable of ["", "full", "thin", "typo"]) {
      const result = runDepth({ event, variable });
      if (variable === "typo") {
        expect(result.exitCode).toBe(1);
        expect(result.diagnostic).toContain("::error::");
        expect(result.diagnostic).toContain("MERGE_QUEUE_DEPTH");
        expect(result.output).toBe("");
        continue;
      }
      if (
        !["merge_group", "pull_request", "workflow_dispatch"].includes(event)
      ) {
        expect(result.exitCode).toBe(1);
        continue;
      }
      expect(result.exitCode).toBe(0);
      const outputs = Object.fromEntries(
        result.output
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(outputs["queue_depth"] ?? "full").toBe(
        event === "merge_group" && variable === "thin" ? "thin" : "full",
      );
      expect(result.output).toContain(
        `suite_depth=${event === "pull_request" ? "fast" : "full"}\n`,
      );
    }
  }
  expect(
    runDepth({ event: "merge_group", variable: "thin", heavyOnly: true })
      .output,
  ).not.toContain("queue_depth=thin");
  expect(
    runDepth({ event: "merge_group", variable: "typo", heavyOnly: true })
      .output,
  ).toBe("");
}, 30_000);

type EvaluateOptions = {
  queueDepth: string;
  job?: string;
  result?: string;
  script?: string;
  /** Release typechecks are planned only when VERSION changes. */
  releaseTypecheck?: boolean;
};
const evaluate = ({
  queueDepth,
  job,
  result,
  script = outcome.run,
  releaseTypecheck = job === "release-typecheck",
}: EvaluateOptions) => {
  const dependencies = Object.fromEntries(
    needs.map((name) => {
      let jobResult =
        heavy.includes(name) && !admitted.includes(name)
          ? "skipped"
          : "success";
      if (name === job) {
        jobResult = result ?? "missing";
      }
      return [
        name,
        {
          result: jobResult,
          outputs: Object.fromEntries(
            Object.keys(folded[name] ?? {}).map((suite) => [suite, jobResult]),
          ),
        },
      ];
    }),
  );
  const rendered = renderResultInputs(script, {
    needs: JSON.stringify(dependencies),
    plan: JSON.stringify({
      ...plan,
      queue_depth: queueDepth,
      heavy_web_build_required: "false",
      release_typecheck_required: releaseTypecheck ? "true" : "false",
    }),
  });
  return Bun.spawnSync(["bash", "-e", "-c", rendered], {
    cwd: root,
    env: {
      ...process.env,
      ...outcome.env,
      EVENT: "merge_group",
      PLAN_RESULT: "success",
      TRUSTED: "true",
      SUITE_DEPTH: "full",
      HEAVY_ONLY: "false",
      COVERAGE_PROFILE: "normal-v1",
      QUEUE_VALIDATION: "false",
      QUEUE_REQUIRED_JOBS: JSON.stringify(admitted),
      QUEUE_DEPTH: queueDepth,
      THIN_JOBS: JSON.stringify(THIN_JOBS),
      HEAVY_JOBS: JSON.stringify(heavy),
      PATCH_ID: "fixture-patch-id",
      WORKFLOW_VERSION: "fixture-workflow-version",
      PR_DEPTH_JOBS: "[]",
      PR_DEPTH_REUSED: "false",
      PR_DEPTH_ONLY: "false",
      PR_DEPTH_SOURCE_RUN_ID: "",
    },
  }).exitCode;
};

test("both queue depths require every planned admitted check to succeed", () => {
  expect(outcome.env?.["QUEUE_DEPTH"]).toBe(
    `\${{ needs.ci-plan.outputs.queue_depth || 'full' }}`,
  );
  expect(outcome.env?.["THIN_JOBS"]).toBe(
    `\${{ needs.ci-plan.outputs.thin_jobs || '[]' }}`,
  );
  for (const queueDepth of ["thin", "full"]) {
    expect(evaluate({ queueDepth }), queueDepth).toBe(0);
    for (const job of admitted) {
      for (const result of ["failure", "cancelled", "timed_out", "skipped"]) {
        expect(
          evaluate({ queueDepth, job, result }),
          `${queueDepth}/${job}/${result}`,
        ).toBe(1);
      }
    }
  }
}, 30_000);

test("an unplanned release typecheck may be skipped at either queue depth", () => {
  for (const queueDepth of ["thin", "full"]) {
    expect(
      evaluate({
        queueDepth,
        job: "release-typecheck",
        result: "skipped",
        releaseTypecheck: false,
      }),
      queueDepth,
    ).toBe(0);
  }
}, 30_000);

test("heavy schedules and ordinary pushes supersede while release runs coalesce by SHA", () => {
  assertMainConcurrency(main);
}, 30_000);

test("unconditional SHA isolation, preserving scheduled work or cancelling release work violate concurrency", () => {
  const perSha = structuredClone(main);
  const preserving = structuredClone(main);
  if (!perSha.concurrency || !preserving.concurrency) {
    panic("Missing main heavy concurrency");
  }
  perSha.concurrency.group = `\${{ github.workflow }}-\${{ inputs.sha || github.sha }}`;
  expect(perSha.concurrency.group).not.toBe(main.concurrency?.group);
  expect(() => assertMainConcurrency(perSha)).toThrow("push/ordinary//group");
  preserving.concurrency["cancel-in-progress"] =
    `\${{ github.event_name != 'schedule' }}`;
  expect(() => assertMainConcurrency(preserving)).toThrow(
    "release heavy work is preserved",
  );
  const cancellingPinned = structuredClone(main);
  const wrongSha = structuredClone(main);
  if (!cancellingPinned.concurrency || !wrongSha.concurrency) {
    panic("Missing main heavy concurrency");
  }
  cancellingPinned.concurrency["cancel-in-progress"] = true;
  expect(() => assertMainConcurrency(cancellingPinned)).toThrow(
    "release heavy work is preserved",
  );
  wrongSha.concurrency.group = wrongSha.concurrency.group.replace(
    "format('release-{0}', inputs.sha)",
    "format('release-{0}', github.sha)",
  );
  expect(wrongSha.concurrency.group).not.toBe(main.concurrency?.group);
  expect(() => assertMainConcurrency(wrongSha)).toThrow(
    "workflow_dispatch/ordinary//group",
  );
}, 30_000);

test("ordinary pushes cannot bypass the hourly heavy scheduling contract", () => {
  assertMainSelection(main);
  const mutated = structuredClone(main);
  const validate = mutated.jobs["validate"];
  if (!validate) {
    panic("Missing main validation job");
  }
  validate.if =
    "github.event_name != 'push' || (vars.MERGE_QUEUE_DEPTH != '' && vars.MERGE_QUEUE_DEPTH != 'full') || startsWith(github.event.head_commit.message, 'chore: release v')";
  expect(() => assertMainSelection(mutated)).toThrow("push/ordinary/");
}, 30_000);

test("invalid configuration blocks ordinary heavy selection and publishes no commit status", () => {
  const validation = step({
    workflow: main,
    job: "validate",
    name: "Validate merge queue depth",
  });
  expect(main.jobs["validate"]?.steps).toContainEqual(validation);
  expect(validation.env?.["MERGE_QUEUE_DEPTH"]).toBe(
    `\${{ vars.MERGE_QUEUE_DEPTH }}`,
  );
  for (const variable of ["", "full", "thin", "typo"]) {
    const result = Bun.spawnSync(["bash", "-e", "-c", validation.run], {
      cwd: root,
      env: { ...process.env, MERGE_QUEUE_DEPTH: variable },
    });
    expect(result.exitCode).toBe(variable === "typo" ? 1 : 0);
    if (variable === "typo") {
      expect(result.stdout.toString() + result.stderr.toString()).toContain(
        "::error::",
      );
    }
  }
  expect(
    selected(main.jobs["suites"]?.if, {
      needs: { validate: { result: "failure" } },
    }),
  ).toBe(false);
  const status = step({
    workflow: main,
    job: "status",
    name: "Publish heavy conclusion",
  });
  const directory = mkdtempSync(path.join(tmpdir(), "thin-status-"));
  const marker = path.join(directory, "called");
  writeFileSync(
    path.join(directory, "gh"),
    `#!/bin/sh\nprintf called > '${marker}'\n`,
    { mode: 0o755 },
  );
  const inheritedPath = process.env["PATH"];
  if (inheritedPath === undefined) {
    panic("Status publication test requires PATH");
  }
  try {
    const result = Bun.spawnSync(["bash", "-e", "-c", status.run], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${directory}:${inheritedPath}`,
        SHA: "",
        RESULTS: JSON.stringify({
          validate: { result: "failure" },
          suites: { result: "skipped" },
        }),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the planner emits the canonical thin set only when derived planning is selected", () => {
  const derive = step({
    workflow: ci,
    job: "ci-plan",
    name: "Derive heavy jobs",
  });
  for (const { event } of events) {
    for (const heavyOnly of [false, true]) {
      for (const queueDepth of ["full", "thin"]) {
        expect(
          selected(derive.if, {
            github: { event_name: event },
            inputs: { heavy_only: heavyOnly },
            steps: {
              depth: { outputs: { queue_depth: queueDepth } },
              "completed-depth": {
                outputs: { run_required: "true", armed: "false" },
              },
              // The derivation also waits for the planner install.
              "planner-deps": { outcome: "success" },
            },
          }),
        ).toBe(heavyOnly || event === "merge_group");
      }
    }
  }
  const result = Bun.spawnSync(
    ["bun", "scripts/main-heavy-plan.ts", ".github/workflows/ci.yml"],
    { cwd: root },
  );
  expect(result.exitCode).toBe(0);
  const outputs = Object.fromEntries(
    result.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  expect(JSON.parse(outputs["thin_jobs"] ?? "")).toEqual(THIN_JOBS);
  expect(JSON.parse(outputs["heavy_jobs"] ?? "")).toEqual(heavy);
}, 30_000);

test("main release and scheduled runs execute the planned version compiler in either queue mode", () => {
  expect(heavy).toContain("release-typecheck");
  expect(scopes["release-typecheck"]).toBe("release_typecheck_required");
  for (const event of [
    { event: "push", message: "chore: release v1.2.3" },
    { event: "schedule", message: "ordinary" },
  ]) {
    for (const variable of ["full", "thin"]) {
      expect(mainSelection({ workflow: main, event, variable }).suites).toBe(
        true,
      );
      const value = context({ event, variable, queueDepth: "full" });
      value.inputs.heavy_only = true;
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic("Missing ci-plan context");
      }
      planner.outputs["release_typecheck_required"] = "true";
      expect(
        selected(ci.jobs["release-typecheck"]?.if, value),
        `${event.event}/${variable}`,
      ).toBe(true);
    }
  }
}, 30_000);

test("a release merge group compiles the next version before it lands, at either queue depth", () => {
  expect(admitted).toContain("release-typecheck");
  for (const queueDepth of ["thin", "full"]) {
    for (const required of ["true", "false"]) {
      const value = context({
        event: { event: "merge_group", message: "chore: release v1.2.3" },
        variable: queueDepth,
        queueDepth,
      });
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic("Missing ci-plan context");
      }
      planner.outputs["release_typecheck_required"] = required;
      expect(
        selected(ci.jobs["release-typecheck"]?.if, value),
        `${queueDepth}/${required}`,
      ).toBe(required === "true");
    }
  }
});

test("queue admission covers every gated job except documented event and producer exceptions", () => {
  const exceptions = new Set(Object.keys(MERGE_GROUP_EXCEPTIONS));
  expect([...admitted].toSorted()).toEqual(
    needs.filter((job) => job !== "ci-plan" && !exceptions.has(job)).toSorted(),
  );
});

test("docs checks certify scoped merge groups at both queue depths", () => {
  expect(admitted).toContain("ci-quick-checks");
  const docs = (ci.jobs["ci-quick-checks"]?.steps ?? []).filter(({ name }) =>
    name?.startsWith("ci-checks-docs: "),
  );
  expect(docs).toHaveLength(1);
  for (const queueDepth of ["thin", "full"]) {
    for (const required of ["true", "false"]) {
      const value = context({
        event: { event: "merge_group", message: "ordinary" },
        variable: queueDepth,
        queueDepth,
      });
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic("Missing ci-plan context");
      }
      planner.outputs["docs_checks_required"] = required;
      const installed = {
        ...value,
        steps: { ...value.steps, install: { outcome: "success" } },
      };
      expect(selected(ci.jobs["ci-quick-checks"]?.if, installed)).toBe(true);
      for (const part of docs) {
        expect(selected(part.if, installed)).toBe(required === "true");
      }
    }
  }
});

test("scoped queue eligibility is invariant under depth and the retired browser switch", () => {
  for (const job of admitted) {
    const scope = scopes[job];
    for (const required of ["true", "false"]) {
      for (const queueBrowserSuites of ["", "on", "off"]) {
        const selections = ["full", "thin"].map((queueDepth) => {
          const value = context({
            event: { event: "merge_group", message: "ordinary" },
            variable: queueDepth,
            queueDepth,
            queueBrowserSuites,
          });
          const planner = value.needs["ci-plan"];
          if (!planner) {
            panic(`Missing ${job} planner context`);
          }
          if (scope) {
            planner.outputs[scope] = required;
          }
          if (scope === "legal_atlas_image_required") {
            planner.outputs["legal_atlas_image_inputs_required"] = required;
          }
          if (job === "postgres-service-suites") {
            planner.outputs["postgres_suites_required"] = required;
          }
          if (job === "service-suites" || job === "ci-browser") {
            planner.outputs["package_checks_required"] = required;
            planner.outputs["collab_redis_required"] = "false";
          }
          return selected(ci.jobs[job]?.if, value);
        });
        expect(selections, `${job}/${required}/${queueBrowserSuites}`).toEqual([
          scope === null || required === "true",
          scope === null || required === "true",
        ]);
      }
    }
  }
});

test("every current CI job disposition is modelled for pull requests", () => {
  // The historical baseline moves with main-heavy.yml edits, so a job only
  // enters that comparison later; model its disposition when it is declared.
  const value = context({
    event: { event: "pull_request", message: "ordinary" },
    variable: "",
    queueDepth: "full",
  });
  for (const job of Object.keys(ci.jobs)) {
    expect(typeof expectedPrSelection({ job, baseline: true, value })).toBe(
      "boolean",
    );
  }
});
