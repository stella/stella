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

import {
  contextFromNested,
  contextWithPlanOutputs,
  evaluate as evaluateExpression,
  UNKNOWN,
} from "./github-expression";
import { mainHeavyJobs, queueAdmittedJobs, thinJobs } from "./main-heavy-plan";

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
const scopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(outcome.env?.["JOB_SCOPES"] ?? ""),
);
const needs = v.parse(v.array(v.string()), ci.jobs["ci-result"]?.needs);
const plan = {
  ...Object.fromEntries(
    Object.values(scopes).flatMap((scope) =>
      scope === null ? [] : [[scope, "true"]],
    ),
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
  agent_sandbox_docker_required: "true",
  api_image_deps_required: "true",
  run_required: "true",
  trusted: "true",
  coverage_profile: "normal-v1",
  pilot_fast_jobs: "[]",
  queue_required_jobs: "[]",
  suite_depth: "full",
  service_suites_pr_required: "false",
  fix_tests_on_base_required: "false",
  api_test_shards: "4",
};
const events = [
  { event: "merge_group", message: "ordinary" },
  { event: "pull_request", message: "ordinary" },
  { event: "push", message: "ordinary" },
  { event: "push", message: "chore: release v1.2.3" },
  { event: "schedule", message: "ordinary" },
  { event: "workflow_dispatch", message: "ordinary" },
];
// Main-only jobs gate on `github.ref`, so every modelled event needs the ref
// GitHub gives it; an unknown ref would leave those conditions unresolved.
const REF_BY_EVENT: Record<string, string> = {
  merge_group: "refs/heads/gh-readonly-queue/main/pr-1-0000000",
  pull_request: "refs/pull/1/merge",
  push: "refs/heads/main",
  schedule: "refs/heads/main",
  workflow_dispatch: "refs/heads/main",
};
const refFor = (event: string) =>
  REF_BY_EVENT[event] ?? panic(`No modelled ref for event ${event}`);
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
}: ContextOptions) => ({
  github: {
    event_name: event,
    ref: refFor(event),
    event: {
      head_commit: { message },
      pull_request: {
        draft: false,
        labels: proveFix ? [{ name: "prove-fix" }] : [],
      },
    },
  },
  vars: {
    MERGE_QUEUE_DEPTH: variable,
    QUEUE_BROWSER_SUITES: queueBrowserSuites,
    CI_POSTGRES_PR_SELECTION: "",
  },
  inputs: { heavy_only: false },
  needs: Object.fromEntries(
    needs.map((job) => {
      const outputs: Record<string, string> =
        job === "ci-plan" ? { ...plan, queue_depth: queueDepth } : {};
      if (job === "ci-plan" && event === "pull_request") {
        outputs["fix_tests_on_base_required"] = "true";
      }
      return [job, { result: "success", outputs }];
    }),
  ),
  always: () => true,
  cancelled: () => false,
  failure: () => false,
  startsWith: (value: string, prefix: string) => value.startsWith(prefix),
});
const selected = (condition: string | undefined, value: object) => {
  const expression = condition ?? "true";
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
test("computed browser planning retains trust, reuse and thin-depth boundaries", () => {
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
                  : suiteDepth === "full" && queueDepth !== "thin");
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

const expectedRouteSelection = (value: ReturnType<typeof context>) => {
  const planner = value.needs["ci-plan"];
  if (!planner) {
    panic("Missing route smoke planner context");
  }
  return (
    value.github.event_name !== "pull_request" &&
    (value.github.event_name !== "merge_group" || !value.cancelled()) &&
    (planner.outputs["queue_depth"] !== "thin" ||
      (value.github.event_name === "merge_group" &&
        value.vars.QUEUE_BROWSER_SUITES !== "off")) &&
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
const expectedPrSelection = ({
  job,
  baseline,
  value,
}: ExpectedPrSelectionOptions) => {
  const disposition = eventPolicy[`ci.yml/${job}`];
  if (disposition === undefined) {
    panic(`Missing CI event disposition: ${job}`);
  }
  if (job === "ci-browser") {
    return (
      value.needs["ci-plan"]?.outputs["trusted"] === "true" &&
      value.needs["ci-plan"].outputs["desktop_browser_required"] === "true"
    );
  }
  switch (disposition) {
    case "queue":
    case "main":
      return false;
    case "pr-opt-in":
      return (
        value.github.event.pull_request.labels.some(
          (label) => label.name === "prove-fix",
        ) && baseline
      );
    case "pr-fast":
      return baseline;
    default:
      return panic(`Unexpected CI event disposition: ${job}/${disposition}`);
  }
};
// Postgres PR selection is a declared exception to the historical full-depth gate.
const expectedServiceSelection = (value: ReturnType<typeof context>) => {
  const outputs = value.needs["ci-plan"]?.outputs;
  if (!outputs) {
    panic("Missing Postgres planner context");
  }
  const event = value.github.event_name;
  return (
    outputs["run_required"] !== "false" &&
    (event !== "pull_request" ||
      value.vars.CI_POSTGRES_PR_SELECTION === "on") &&
    outputs["queue_depth"] !== "thin" &&
    (outputs["package_checks_required"] === "true" ||
      outputs["collab_redis_required"] === "true") &&
    (outputs["trusted"] === "true" || event === "workflow_dispatch") &&
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
    needs: { validate: { result: validationResult, outputs: { run: "true" } } },
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
        expect(selected(job.if, value), `${id}/${event.event}/${failed}`).toBe(
          failed && event.event === "merge_group",
        );
        if (event.event === "merge_group") {
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

test("route smoke certifies planned queue and heavy builds while skipping PRs", () => {
  expect(eventPolicy["ci.yml/route-smoke"]).toBe("queue");
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

test("unset and full preserve historical predicates except declared PR, Postgres and route ownership changes", () => {
  const baseline = original("ci.yml");
  const baselineMain = original("main-heavy.yml");
  expect(Object.keys(main.jobs)).toEqual(Object.keys(baselineMain.jobs));
  expect(Object.keys(ci.jobs).toSorted()).toEqual(
    [
      ...new Set([
        ...Object.keys(baseline.jobs).filter(
          (id) => id !== "merge-group-fail-fast",
        ),
        "api-test-durations",
        "marketing-screenshots-cancel",
        "ci-generated-sources",
        "ci-checks-docs",
      ]),
    ].toSorted(),
  );
  for (const event of events) {
    for (const { variable, proveFix } of ["", "full"].flatMap((queueVariable) =>
      [false, true].map((labelRequested) => ({
        variable: queueVariable,
        proveFix: labelRequested,
      })),
    )) {
      const value = context({ event, variable, queueDepth: "full", proveFix });
      for (const [job, body] of Object.entries(baseline.jobs)) {
        if (job === "merge-group-fail-fast") {
          continue;
        }
        let expected = selected(body.if, value);
        if (job === "service-suites") {
          expected = expectedServiceSelection(value);
        } else if (job === "route-smoke") {
          expected = expectedRouteSelection(value);
        } else if (event.event === "pull_request") {
          expected = expectedPrSelection({ job, baseline: expected, value });
        }
        expect(
          selected(ci.jobs[job]?.if, value),
          `${event.event}/${event.message}/${variable}/${proveFix}/${job}`,
        ).toBe(expected);
      }
    }
  }
}, 30_000);

test("one variable moves only derived heavy jobs from merge groups to ordinary main pushes", () => {
  const baseline = original("ci.yml");
  for (const event of events) {
    for (const variable of ["", "full", "thin", "typo"]) {
      const heavyOnly = mainTriggered(event.event);
      const resolved = runDepth({ event: event.event, variable, heavyOnly });
      const thinQueue =
        !heavyOnly && event.event === "merge_group" && variable === "thin";
      const outputs = Object.fromEntries(
        resolved.output
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      const value = context({
        event,
        variable,
        queueDepth: outputs["queue_depth"] ?? "full",
      });
      value.inputs.heavy_only = heavyOnly;
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic("Missing ci-plan context");
      }
      planner.result = resolved.exitCode === 0 ? "success" : "failure";
      planner.outputs["suite_depth"] = outputs["suite_depth"] ?? "";
      if (heavyOnly) {
        planner.outputs["landing_build_required"] = "false";
        planner.outputs["fix_tests_on_base_required"] = "false";
        planner.outputs["heavy_web_build_required"] = "true";
      }
      const invoked =
        !heavyOnly || mainSelection({ workflow: main, event, variable }).suites;
      for (const job of needs.filter((name) => name !== "ci-plan")) {
        const runs =
          invoked &&
          resolved.exitCode === 0 &&
          selected(ci.jobs[job]?.if, value);
        if (heavyOnly) {
          const scope = scopes[job];
          const planned =
            scope === null ||
            (scope !== undefined && planner.outputs[scope] === "true");
          expect(runs, `${event.event}/${variable}/${job}`).toBe(
            invoked &&
              resolved.exitCode === 0 &&
              heavy.includes(job) &&
              planned,
          );
          continue;
        }
        if (
          resolved.exitCode !== 0 ||
          (thinQueue && heavy.includes(job) && !admitted.includes(job))
        ) {
          expect(runs, `${event.event}/${variable}/${job}`).toBe(false);
          continue;
        }
        // An admitted browser suite keeps its full-depth queue selection in a
        // thin group while the switch is unset.
        const certified =
          thinQueue && admitted.includes(job)
            ? {
                ...value,
                needs: {
                  ...value.needs,
                  "ci-plan": {
                    ...planner,
                    outputs: { ...planner.outputs, queue_depth: "full" },
                  },
                },
              }
            : value;
        let expected = selected(baseline.jobs[job]?.if, certified);
        if (job === "service-suites") {
          expected = expectedServiceSelection(value);
        } else if (job === "route-smoke") {
          expected = expectedRouteSelection(value);
        } else if (event.event === "pull_request") {
          expected = expectedPrSelection({ job, baseline: expected, value });
        }
        expect(runs, `${event.event}/${variable}/${job}`).toBe(expected);
      }
    }
  }
  assertMainSelection(main);
}, 30_000);

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
};
const evaluate = ({
  queueDepth,
  job,
  result,
  script = outcome.run,
}: EvaluateOptions) => {
  const dependencies = Object.fromEntries(
    needs.map((name) => {
      if (name === job) {
        return [name, { result, outputs: {} }];
      }
      return [
        name,
        { result: heavy.includes(name) ? "skipped" : "success", outputs: {} },
      ];
    }),
  );
  return Bun.spawnSync(["bash", "-e", "-c", script], {
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
      QUEUE_REQUIRED_JOBS: "[]",
      QUEUE_DEPTH: queueDepth,
      THIN_JOBS: JSON.stringify(THIN_JOBS),
      HEAVY_JOBS: JSON.stringify(heavy),
      PLAN: JSON.stringify({ ...plan, queue_depth: queueDepth }),
      NEEDS: JSON.stringify(dependencies),
    },
  }).exitCode;
};

test("thin aggregation accepts only intended heavy skips and still requires every planned thin check", () => {
  expect(outcome.env?.["QUEUE_DEPTH"]).toBe(
    `\${{ needs.ci-plan.outputs.queue_depth || 'full' }}`,
  );
  expect(outcome.env?.["THIN_JOBS"]).toBe(
    `\${{ needs.ci-plan.outputs.thin_jobs || '[]' }}`,
  );
  expect(evaluate({ queueDepth: "thin" })).toBe(0);
  expect(evaluate({ queueDepth: "full" })).toBe(1);
  for (const job of [...THIN_JOBS, ...heavy]) {
    for (const result of ["failure", "cancelled", "timed_out"]) {
      expect(
        evaluate({ queueDepth: "thin", job, result }),
        `${job}/${result}`,
      ).toBe(1);
    }
  }
  for (const job of THIN_JOBS) {
    expect(evaluate({ queueDepth: "thin", job, result: "skipped" }), job).toBe(
      1,
    );
  }
}, 30_000);

test("ignoring queue depth in the result gate breaks intended thin skips", () => {
  expect(evaluate({ queueDepth: "thin" })).toBe(0);
  expect(
    evaluate({
      queueDepth: "thin",
      script: `QUEUE_DEPTH=full\n${outcome.run}`,
    }),
  ).toBe(1);
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
  expect(main.jobs["validate"]?.steps?.at(1)).toEqual(validation);
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
              "completed-depth": { outputs: { run_required: "true" } },
            },
          }),
        ).toBe(heavyOnly || (event === "merge_group" && queueDepth === "thin"));
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

test("thin merge groups admit exactly the planned browser suites until the switch turns them off", () => {
  expect([...admitted].toSorted()).toEqual(
    ["e2e-production-shard", "route-smoke"].toSorted(),
  );
  for (const job of admitted) {
    // Main-heavy keeps certifying them after merge as well.
    expect(heavy, job).toContain(job);
    const scope = scopes[job];
    if (!scope) {
      panic(`Missing planner scope for ${job}`);
    }
    for (const planned of [false, true]) {
      for (const queueBrowserSuites of ["", "on", "off"]) {
        const value = context({
          event: { event: "merge_group", message: "ordinary" },
          variable: "thin",
          queueDepth: "thin",
          queueBrowserSuites,
        });
        const planner = value.needs["ci-plan"];
        const heavyWeb = value.needs["heavy-web-build"];
        if (!planner || !heavyWeb) {
          panic(`Missing ${job} build context`);
        }
        planner.outputs[scope] = String(planned);
        heavyWeb.result = "skipped";
        expect(
          selected(ci.jobs[job]?.if, value),
          `${job}/${planned}/${queueBrowserSuites}`,
        ).toBe(planned && queueBrowserSuites !== "off");
      }
    }
  }
});

test("a browser suite without the queue switch drops out of thin merge groups", () => {
  const mutated = structuredClone(ci);
  const smoke = mutated.jobs["route-smoke"];
  if (!smoke?.if) {
    panic("Missing route smoke condition");
  }
  smoke.if = smoke.if.replace(
    "(needs.ci-plan.outputs.queue_depth != 'thin' || (github.event_name == 'merge_group' && vars.QUEUE_BROWSER_SUITES != 'off'))",
    "needs.ci-plan.outputs.queue_depth != 'thin'",
  );
  expect(queueAdmittedJobs(mutated)).not.toContain("route-smoke");
  const value = context({
    event: { event: "merge_group", message: "ordinary" },
    variable: "thin",
    queueDepth: "thin",
  });
  expect(selected(smoke.if, value)).toBe(false);
});

test("the queue switch admits browser suites only in merge groups", () => {
  for (const job of admitted) {
    const scope = scopes[job];
    if (!scope) {
      panic(`Missing planner scope for ${job}`);
    }
    for (const event of events.filter(
      (candidate) => candidate.event !== "merge_group",
    )) {
      // A thin depth outside a merge group is not emitted today; the condition
      // must still refuse it rather than rely on the resolver.
      const value = context({ event, variable: "thin", queueDepth: "thin" });
      const planner = value.needs["ci-plan"];
      if (!planner) {
        panic(`Missing ${job} planner context`);
      }
      planner.outputs[scope] = "true";
      expect(
        selected(ci.jobs[job]?.if, value),
        `${job}/${event.event}/${event.message}`,
      ).toBe(false);
    }
  }
});
