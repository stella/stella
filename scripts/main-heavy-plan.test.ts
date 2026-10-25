import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import eventPolicies from "../.github/ci-event-policy.json" with { type: "json" };
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { ciExpressionContext, modelledEvent } from "./ci-expression-context";
import { renderResultInputs } from "./ci-result-inputs";
import serviceImages from "./ci-service-images.json" with { type: "json" };
import {
  contextFromNested,
  contextWithPlanOutputs,
  evaluate as evaluateExpression,
  UNKNOWN,
} from "./github-expression";
import {
  heavyProofJobScopes,
  mainHeavyJobs,
  MERGE_GROUP_EXCEPTIONS,
  prDepthJobs,
  queueAdmittedJobs,
  thinJobs,
} from "./main-heavy-plan";

const root = new URL("../", import.meta.url).pathname;
const source = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflowSchema = v.object({
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
const workflow = v.parse(workflowSchema, Bun.YAML.parse(source));
// Resolve the real-checkout baseline during suite setup, as the CI partition
// tests do. Git history and lazy blob fetches are not unit-test work.
const baselineGit = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  if (childExitStatus(result) !== 0) {
    panic(
      `Heavy policy baseline unavailable: git ${args.join(" ")}; exit status ${result.exitCode}, signal ${String(result.signalCode)}; ${result.stderr.toString().trim() || "git produced no diagnostic"}`,
    );
  }
  return result.stdout.toString().trim();
};
const baselineRevision = baselineGit(["merge-base", "origin/main", "HEAD"]);
const original = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    baselineGit(["show", `${baselineRevision}:.github/workflows/ci.yml`]),
  ),
);
const querySource = readFileSync(
  new URL("../.github/workflows/query-perf.yml", import.meta.url),
  "utf-8",
);
const queryWorkflow = v.parse(workflowSchema, Bun.YAML.parse(querySource));
const planOutputs = v.parse(
  v.record(v.string(), v.string()),
  workflow.jobs["ci-plan"]?.outputs,
);
const THIN_JOBS = thinJobs(workflow);
const heavy = mainHeavyJobs(workflow);
const outcome = workflow.jobs["ci-result"]?.steps?.find(
  ({ name }) => name === "Evaluate CI outcome",
);
const outcomeEnv = outcome?.env;
if (!outcome?.run || !outcomeEnv) {
  panic("Missing CI outcome step");
}
const scopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(outcomeEnv["JOB_SCOPES"] ?? ""),
);
const foldedSuites = v.parse(
  v.record(v.string(), v.record(v.string(), v.string())),
  JSON.parse(outcomeEnv["FOLDED_SUITES"] ?? ""),
);
const expectedHeavy = Object.keys(scopes).filter(
  (job) => !THIN_JOBS.some((thin) => thin === job),
);
const ciNeeds = v.parse(v.array(v.string()), workflow.jobs["ci-result"]?.needs);

const selected = (condition: string, context: object) => {
  const result = evaluateExpression(
    condition,
    contextWithPlanOutputs({
      context: contextFromNested(context),
      outputs: planOutputs,
    }),
  );
  if (result === UNKNOWN) {
    panic(`Unresolved heavy-plan expression: ${condition}`);
  }
  return Boolean(result);
};
const context = (
  event: string,
  heavyOnly: boolean,
  plan: Record<string, string>,
) => {
  const value = ciExpressionContext({
    event: modelledEvent(event),
    heavyOnly,
    plan,
    needsResults: Object.fromEntries(
      ciNeeds.map((job) => [
        job,
        heavyOnly && THIN_JOBS.some((thin) => thin === job)
          ? "skipped"
          : "success",
      ]),
    ),
    stepOutputs: {
      "marketing-release": {
        required: plan["marketing_screenshots_required"] ?? "false",
      },
    },
  });
  value.steps = {
    "changed-files": { outputs: plan },
    "marketing-release": {
      outputs: { required: plan["marketing_screenshots_required"] ?? "false" },
    },
    suites: {
      outputs: {
        heavy_proof:
          plan["heavy_proof"] ??
          String(plan["run_required"] !== "false" && event !== "pull_request"),
      },
    },
    // Unarmed pull requests and merge groups without armed proof.
    "completed-depth": {
      outputs: {
        armed: plan["armed"] ?? "false",
        armed_proof: plan["armed_proof"] ?? "",
        run_required: plan["run_required"] ?? "true",
        pr_heavy_suites: plan["pr_heavy_suites"] ?? "run",
      },
    },
  };
  return value;
};

const planned = (plan: Record<string, string>, job: string) => {
  const scope = scopes[job];
  return scope === null || (scope !== undefined && plan[scope] === "true");
};
// Computed job scopes also depend on changed-file scopes that are not gated
// directly. Pin their source outputs; unrelated scopes remain unplanned.
const directScopePattern =
  /^\$\{\{\s*(steps\.[\w-]+\.outputs\.[\w-]+_required)(?:\s*\|\|\s*'[^']*')?\s*\}\}$/u;
const computedScopeInputs = new Set(
  Object.values(planOutputs)
    .filter((expression) => !directScopePattern.test(expression))
    .flatMap((expression) =>
      [
        ...expression.matchAll(/\bsteps\.[\w-]+\.outputs\.[\w-]+_required\b/gu),
      ].map(([reference]) => reference),
    ),
);
const allPlanned = Object.fromEntries(
  [
    ...new Set([
      ...Object.values(scopes).filter((scope) => scope !== null),
      ...Object.values(foldedSuites).flatMap(Object.values),
      ...Object.entries(planOutputs)
        .filter(([, expression]) => {
          const reference = directScopePattern.exec(expression)?.[1];
          return reference !== undefined && computedScopeInputs.has(reference);
        })
        .map(([name]) => name),
    ]),
  ].map((scope) => [scope, "true"]),
);
const heavyPlan = {
  ...allPlanned,
  package_checks_required: "true",
  trusted: "true",
  coverage_profile: "normal-v1",
  pilot_fast_jobs: "[]",
  queue_required_jobs: "[]",
  suite_depth: "full",
  queue_depth: "full",
  browser_spec_selection_required: "true",
  fix_tests_on_base_required: "false",
};

const heavyEvents = ["push", "schedule", "workflow_dispatch"] as const;

test("main heavy suites include the Windows desktop dry run", () => {
  expect(heavy).toContain("desktop-windows-dry-run");
});

test("dedicated query recording dispatch schedules one measurement job", () => {
  const parsed = v.parse(
    v.object({ on: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(querySource),
  );
  expect(Object.keys(parsed.on)).toEqual([
    "workflow_call",
    "workflow_dispatch",
  ]);
  expect(parsed.on["workflow_dispatch"]).toBeNull();
  expect(JSON.stringify(parsed.on["workflow_call"])).not.toContain("record");
  expect(Object.keys(queryWorkflow.jobs)).toEqual(["query-perf"]);
  expect(queryWorkflow.jobs["query-perf"]?.needs).toBeUndefined();
  const caller = v.parse(
    v.object({ uses: v.string(), with: v.record(v.string(), v.string()) }),
    v.parse(
      v.object({ jobs: v.record(v.string(), v.unknown()) }),
      Bun.YAML.parse(source),
    ).jobs["query-perf"],
  );
  expect(caller.uses).toBe("./.github/workflows/query-perf.yml");
  expect(Object.keys(caller.with)).toEqual(["sha", "heavy_only"]);
  const serviceSchema = v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        services: v.optional(
          v.record(v.string(), v.looseObject({ image: v.string() })),
        ),
      }),
    ),
  });
  const services = v.parse(serviceSchema, Bun.YAML.parse(source));
  const queryServices = v.parse(serviceSchema, Bun.YAML.parse(querySource));
  const postgres =
    serviceImages.find(({ name }) => name === "postgres") ??
    panic("Missing canonical PostgreSQL image");
  const queryPostgresImage =
    queryServices.jobs["query-perf"]?.services?.["postgres"]?.image ??
    panic("Missing query performance PostgreSQL image");
  expect(`docker.io/library/${queryPostgresImage}`).toBe(postgres.source);
  expect(
    evaluateExpression(
      services.jobs["service-suites"]?.services?.["postgres"]?.image ??
        panic("Missing service-suite PostgreSQL image"),
      contextFromNested({
        needs: { "ci-plan": { outputs: { postgres: postgres.source } } },
      }),
    ),
  ).toBe(postgres.source);
  const steps = queryWorkflow.jobs["query-perf"]?.steps ?? [];
  const recording =
    steps.find(({ name }) => name === "Run query performance suite")?.env?.[
      "QUERY_PERF_BASELINE_MODE"
    ] ?? panic("Missing recording mode");
  const value = {
    cancelled: () => false,
    steps: {
      measurements: { outputs: { baseline_recorded: "true" } },
      validation: { outcome: "success" },
    },
    github: {
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      repository: "stella/stella",
      workflow_ref:
        "stella/stella/.github/workflows/query-perf.yml@refs/heads/test",
    },
  };
  expect(evaluateExpression(recording, contextFromNested(value))).toBe(
    "record",
  );
  expect(selected(queryWorkflow.jobs["query-perf"]?.if ?? "true", value)).toBe(
    true,
  );
  expect(
    selected(queryWorkflow.jobs["query-perf"]?.if ?? "true", {
      ...value,
      github: { ...value.github, ref: "refs/heads/feature/test" },
    }),
  ).toBe(false);
  for (const step of steps.filter(
    ({ name }) =>
      name === "Validate recorded baseline" ||
      name === "Upload recorded baseline",
  )) {
    expect(selected(step.if ?? "true", value)).toBe(true);
  }
});

test("query budgets select affected changes and explicit recordings", () => {
  const condition =
    workflow.jobs["query-perf"]?.if ?? panic("Missing query performance job");
  const steps =
    queryWorkflow.jobs["query-perf"]?.steps ??
    panic("Missing query performance steps");
  const recording =
    steps.find(({ name }) => name === "Run query performance suite")?.env?.[
      "QUERY_PERF_BASELINE_MODE"
    ] ?? panic("Missing query recording mode");
  const validation =
    steps.find(({ name }) => name === "Validate recorded baseline") ??
    panic("Missing recording validation");
  expect(validation.run).toBe("bun scripts/query-perf-baseline.ts --validate");
  for (const event of [
    "pull_request",
    "merge_group",
    "push",
    "schedule",
    "workflow_dispatch",
  ]) {
    for (const required of ["true", "false"]) {
      for (const mode of ["compare", "record"]) {
        const value = {
          ...context(event, false, {
            ...heavyPlan,
            query_perf_required: required,
          }),
          inputs: {
            heavy_only: false,
            pr_depth_only: false,
            query_perf_mode: mode,
          },
        };
        expect(selected(condition, value), `${event}/${required}/${mode}`).toBe(
          (event === "pull_request" || event === "merge_group") &&
            required === "true",
        );
        const called = {
          ...value,
          steps: {
            ...value.steps,
            measurements: { outputs: { baseline_recorded: "false" } },
          },
          github: {
            ...value.github,
            repository: "stella/stella",
            workflow_ref:
              "stella/stella/.github/workflows/ci.yml@refs/heads/test",
          },
        };
        expect(evaluateExpression(recording, contextFromNested(called))).toBe(
          "compare",
        );
        expect(selected(validation.if ?? "true", called)).toBe(false);
        const reused = {
          ...context(event, false, {
            ...heavyPlan,
            run_required: "false",
            query_perf_required: required,
          }),
          inputs: value.inputs,
        };
        expect(selected(condition, reused)).toBe(false);
      }
    }
  }
});

test("missing-baseline artifacts survive failed measurements only after validation", () => {
  const steps = queryWorkflow.jobs["query-perf"]?.steps ?? [];
  const validation =
    steps.find(({ name }) => name === "Validate recorded baseline") ??
    panic("Missing recording validator");
  const upload =
    steps.find(({ name }) => name === "Upload recorded baseline") ??
    panic("Missing recording upload");
  for (const recorded of ["true", "false"]) {
    for (const validationOutcome of ["success", "failure", "skipped"]) {
      const value = {
        cancelled: () => false,
        success: () => false,
        failure: () => true,
        steps: {
          measurements: {
            outcome: "failure",
            outputs: { baseline_recorded: recorded },
          },
          validation: { outcome: validationOutcome },
        },
      };
      expect(selected(validation.if ?? "true", value)).toBe(
        recorded === "true",
      );
      expect(selected(upload.if ?? "true", value)).toBe(
        recorded === "true" && validationOutcome === "success",
      );
    }
  }
});

const assertCoverage = (jobs: string[], event: string) => {
  expect(new Set(jobs)).toEqual(new Set(expectedHeavy));
  const scheduled = Object.entries(workflow.jobs)
    .filter(
      ([job, body]) =>
        job !== "ci-plan" &&
        job !== "ci-result" &&
        ciNeeds.includes(job) &&
        selected(body.if ?? "true", context(event, true, heavyPlan)),
    )
    .map(([job]) => job);
  expect(new Set(scheduled)).toEqual(
    new Set(jobs.filter((job) => planned(heavyPlan, job))),
  );
};

test("main heavy scheduling equals the gated jobs minus thin checks", () => {
  for (const event of heavyEvents) {
    assertCoverage(heavy, event);
    for (const thin of THIN_JOBS) {
      expect(
        selected(
          workflow.jobs[thin]?.if ?? "true",
          context(event, true, heavyPlan),
        ),
        `${event}/${thin}`,
      ).toBe(false);
    }
  }
  const planner = workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Derive heavy jobs",
  );
  expect(planner?.run).toContain(
    'git show "$WORKFLOW_SHA:.github/workflows/ci.yml"',
  );
  expect(planner?.run).toContain(
    'git show "$WORKFLOW_SHA:scripts/main-heavy-plan.ts"',
  );
  // The copied planner runs from packages/scripts, so every script it reaches
  // through a relative import must be copied beside it.
  const pending = ["main-heavy-plan"];
  for (const seen = new Set<string>(); pending.length > 0;) {
    const name = pending.pop() ?? "";
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const script = readFileSync(
      path.resolve(import.meta.dirname, `${name}.ts`),
      "utf-8",
    );
    for (const [, imported = ""] of script.matchAll(/from "\.\/([\w.-]+)"/gu)) {
      expect(planner?.run).toContain(
        `git show "$WORKFLOW_SHA:scripts/${imported}.ts" > packages/scripts/${imported}.ts`,
      );
      pending.push(imported);
    }
  }
  expect(planner?.env?.["WORKFLOW_SHA"]).toBe(`\${{ github.workflow_sha }}`);
});

const assertMergeGroupCoverage = (definition: typeof workflow) => {
  const admitted = queueAdmittedJobs(definition);
  for (const name of admitted) {
    const body = definition.jobs[name];
    if (!body) {
      panic(`Missing merge-group job: ${name}`);
    }
    for (const queueDepth of ["thin", "full"]) {
      expect(
        selected(
          body.if ?? "true",
          context("merge_group", false, {
            ...heavyPlan,
            queue_depth: queueDepth,
            ci_browser_required: "true",
          }),
        ),
        `${name}/${queueDepth}`,
      ).toBe(true);
    }
  }
  for (const [name, reason] of Object.entries(MERGE_GROUP_EXCEPTIONS)) {
    expect(ciNeeds, name).toContain(name);
    expect(reason.trim().length, name).toBeGreaterThan(0);
  }
};

test("every gated code job certifies affected merge groups at both queue depths", () => {
  assertMergeGroupCoverage(workflow);
});

test("unaffected merge groups skip every scoped code job at both depths", () => {
  for (const queueDepth of ["thin", "full"]) {
    const unaffected = context("merge_group", false, {
      ...heavyPlan,
      ...Object.fromEntries(
        Object.keys(allPlanned).map((scope) => [scope, "false"]),
      ),
      package_checks_required: "false",
      queue_depth: queueDepth,
    });
    for (const name of queueAdmittedJobs(workflow)) {
      if (scopes[name] === null) {
        continue;
      }
      expect(
        selected(workflow.jobs[name]?.if ?? "true", unaffected),
        `${name}/${queueDepth}`,
      ).toBe(false);
    }
  }
});

test("a thin-depth skip on any gated code job violates merge-group coverage", () => {
  for (const name of queueAdmittedJobs(workflow)) {
    const mutated = structuredClone(workflow);
    const job = mutated.jobs[name];
    if (!job) {
      panic(`Missing mutation job: ${name}`);
    }
    const condition = job.if?.trim() ?? "true";
    const body = /^\$\{\{([\s\S]*)\}\}$/u.exec(condition)?.[1] ?? condition;
    job.if = `\${{ needs.ci-plan.outputs.queue_depth != 'thin' && (${body}) }}`;
    expect(() => assertMergeGroupCoverage(mutated), name).toThrow(
      `${name}/thin`,
    );
  }
});

test("production web artifacts have at most one selected producer", () => {
  const producers = Object.entries(workflow.jobs).filter(([, body]) =>
    body.steps?.some(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.["name"] === "e2e-web-build",
    ),
  );
  expect(producers.map(([job]) => job).toSorted()).toEqual([
    "heavy-web-build",
    "web-build",
  ]);
  for (const event of ["pull_request", "merge_group", ...heavyEvents]) {
    for (const heavyOnly of [false, true]) {
      for (const required of ["true", "false"]) {
        for (const queueDepth of ["full", "thin"]) {
          const value = context(event, heavyOnly, {
            ...heavyPlan,
            queue_depth: queueDepth,
            web_build_required: required,
            heavy_web_build_required: heavyOnly ? required : "false",
          });
          const active = producers
            .filter(([, body]) => selected(body.if ?? "true", value))
            .map(([job]) => job);
          expect(
            active.length,
            `${event}/${heavyOnly}/${required}/${queueDepth}`,
          ).toBeLessThanOrEqual(1);
          if (
            event === "workflow_dispatch" &&
            heavyOnly &&
            required === "true" &&
            queueDepth === "full"
          ) {
            expect(active).toEqual(["heavy-web-build"]);
          }
        }
      }
    }
  }
});

test("main heavy runs execute the release compiler exactly when VERSION is planned", () => {
  for (const event of heavyEvents) {
    for (const required of ["true", "false"]) {
      expect(
        selected(
          workflow.jobs["release-typecheck"]?.if ?? "true",
          context(event, true, {
            ...heavyPlan,
            release_typecheck_required: required,
          }),
        ),
        `${event}/${required}`,
      ).toBe(required === "true");
    }
  }
});

test("completed-depth reuse skips every nonstructural main heavy job", () => {
  for (const event of heavyEvents) {
    const reused = context(event, true, {
      ...heavyPlan,
      run_required: "false",
    });
    for (const [job, body] of Object.entries(workflow.jobs)) {
      if (
        job === "ci-plan" ||
        job === "ci-result" ||
        job === "ci-quick-checks"
      ) {
        continue;
      }
      expect(selected(body.if ?? "true", reused), `${event}/${job}`).toBe(
        false,
      );
    }
  }
});

test("dropping a heavy job cannot pass the scheduling invariant", () => {
  const removed = heavy.at(0);
  expect(removed).toBeDefined();
  for (const event of heavyEvents) {
    expect(() =>
      assertCoverage(
        heavy.filter((job) => job !== removed),
        event,
      ),
    ).toThrow("expect(received)");
  }
});

test("heavy planning rejects gate drift instead of omitting a job", () => {
  const mutated = structuredClone(workflow);
  const needs = v.parse(v.array(v.string()), mutated.jobs["ci-result"]?.needs);
  const result = mutated.jobs["ci-result"];
  if (!result) {
    panic("Missing result job");
  }
  result.needs = needs.filter((job) => job !== heavy.at(0));
  expect(() => mainHeavyJobs(mutated)).toThrow(
    "ci-result dependencies and JOB_SCOPES disagree",
  );
});

test("heavy event policies exclude pull requests and preserve existing full certification", () => {
  let compared = 0;
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    for (const depth of ["fast", "full"]) {
      for (const required of ["true", "false"]) {
        const plan = Object.fromEntries(
          Object.keys(allPlanned).map((scope) => [scope, required]),
        );
        plan["trusted"] = "true";
        plan["suite_depth"] = depth;
        plan["queue_depth"] = "full";
        plan["heavy_web_build_required"] = "false";
        plan["browser_spec_selection_required"] = required;
        plan["docker_checks_pr_required"] = required;
        // Queue policies intentionally remove PR execution. Existing non-PR
        // certification stays unchanged except for the added queue route smoke.
        for (const [job, body] of Object.entries(original.jobs)) {
          const current = workflow.jobs[job]?.if;
          if (current?.includes("inputs.heavy_only") !== true) {
            continue;
          }
          compared += 1;
          let expected = selected(
            body.if ?? "true",
            context(event, false, plan),
          );
          const queueJob = Object.entries(eventPolicies.jobs).some(
            ([key, policy]) =>
              key === `ci.yml/${job}` &&
              (policy === "queue" || policy === "main" || policy === "armed"),
          );
          if (event === "pull_request" && queueJob) {
            expected = false;
          }
          if (
            current.includes(
              "needs.ci-plan.outputs.package_checks_required == 'true'",
            )
          ) {
            expected = expected && required === "true";
          }
          if (job === "docker-checks" && event === "merge_group") {
            expected = required === "true";
          }
          if (job === "route-smoke" && event === "merge_group") {
            expected = required === "true";
          }
          // Selected browser specs build the web app on pull requests.
          if (
            event === "pull_request" &&
            current.includes(
              "needs.ci-plan.outputs.browser_spec_selection_required == 'true'",
            )
          ) {
            expected = required === "true";
          }
          // Selected production e2e specs run on pull requests when planned.
          if (event === "pull_request" && job === "e2e-production-shard") {
            expected = required === "true";
          }
          // Pull request quick checks run in the heavy-suite gate, so the gate
          // runs where the baseline quick checks ran and they skip there.
          if (job === "pr-heavy-gate") {
            expected =
              event === "pull_request" &&
              selected(
                original.jobs["ci-quick-checks"]?.if ?? "true",
                context(event, false, plan),
              );
          }
          if (job === "ci-quick-checks" && event === "pull_request") {
            expected = false;
          }
          expect(
            selected(current, context(event, false, plan)),
            `${event}/${depth}/${required}/${job}`,
          ).toBe(expected);
        }
        expect(
          selected(
            workflow.jobs["heavy-web-build"]?.if ?? "true",
            context(event, false, plan),
          ),
        ).toBe(false);
      }
    }
  }
  expect(compared).toBeGreaterThan(0);
}, 30_000);

type EvaluateOptions = {
  event: string;
  jobName?: string;
  result: string;
  isPlanned?: boolean;
  planResult?: string;
  thinResult?: string;
  suiteResults?: Record<string, string>;
};
const evaluate = ({
  event,
  jobName = "mobile-build",
  result,
  isPlanned = true,
  planResult = "success",
  thinResult = "skipped",
  suiteResults = {},
}: EvaluateOptions) => {
  const needs = Object.fromEntries(
    ciNeeds.map((job) => {
      let jobResult = "success";
      if (job === "ci-plan") {
        jobResult = planResult;
      } else if (THIN_JOBS.some((thin) => thin === job)) {
        jobResult = thinResult;
      }
      return [
        job,
        {
          result: jobResult,
          outputs: Object.fromEntries(
            Object.keys(foldedSuites[job] ?? {}).map((suite) => [
              suite,
              suiteResults[suite] ?? "success",
            ]),
          ),
        },
      ];
    }),
  );
  const job = needs[jobName];
  const scope = scopes[jobName];
  if (!job || typeof scope !== "string") {
    panic(`Missing scoped job: ${jobName}`);
  }
  job.result = result;
  const script = renderResultInputs(outcome.run ?? "exit 2", {
    needs: JSON.stringify(needs),
    plan: JSON.stringify({ ...heavyPlan, [scope]: String(isPlanned) }),
  });
  const run = Bun.spawnSync(["bash", "-e", "-c", script], {
    cwd: root,
    env: {
      ...process.env,
      ...outcomeEnv,
      EVENT: event,
      HEAVY_ONLY: "true",
      HEAVY_JOBS: JSON.stringify(heavy),
      QUEUE_DEPTH: "full",
      THIN_JOBS: JSON.stringify(THIN_JOBS),
      PLAN_RESULT: planResult,
      TRUSTED: "true",
      SUITE_DEPTH: "full",
      PR_DEPTH_JOBS: JSON.stringify(prDepthJobs(workflow)),
      PR_DEPTH_REUSED: "false",
      PR_DEPTH_ONLY: "false",
    },
  });
  return run.exitCode;
};

test("main heavy aggregation rejects unsuccessful or missing folded verdicts", () => {
  for (const event of heavyEvents) {
    expect(evaluate({ event, result: "success" }), event).toBe(0);
    for (const suites of Object.values(foldedSuites)) {
      for (const suite of Object.keys(suites)) {
        for (const verdict of ["failure", "cancelled", "skipped", ""]) {
          expect(
            evaluate({
              event,
              result: "success",
              suiteResults: { [suite]: verdict },
            }),
            `${event}/${suite}/${verdict}`,
          ).toBe(1);
        }
      }
    }
  }
}, 30_000);

test("main heavy aggregation rejects failures, cancellations, timeouts and planned skips", () => {
  for (const event of heavyEvents) {
    for (const result of [
      "success",
      "failure",
      "skipped",
      "cancelled",
      "timed_out",
    ]) {
      for (const isPlanned of [true, false]) {
        const accepted =
          result === "success" || (result === "skipped" && !isPlanned);
        expect(
          evaluate({ event, result, isPlanned }),
          `${event}/${result}/${isPlanned}`,
        ).toBe(accepted ? 0 : 1);
      }
    }
    for (const planResult of ["failure", "cancelled"]) {
      expect(
        evaluate({ event, result: "success", planResult }),
        `${event}/plan/${planResult}`,
      ).toBe(1);
    }
  }
}, 30_000);

test("the reusable result gate allows skipped thin checks in heavy mode", () => {
  for (const event of heavyEvents) {
    expect(evaluate({ event, result: "success" }), event).toBe(0);
  }
}, 30_000);

test("heavy scope selection plans full suites with runnable folded producers even on an empty main diff", () => {
  const scope = workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Check changed file scope",
  );
  if (!scope?.run) {
    panic("Missing changed file scope");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "main-heavy-plan-"));
  const output = path.join(directory, "output");
  try {
    for (const event of heavyEvents) {
      writeFileSync(output, "");
      const run = Bun.spawnSync(["bash", "-e", "-c", scope.run], {
        cwd: root,
        env: {
          ...process.env,
          EVENT_NAME: event,
          HEAVY_ONLY: "true",
          SUITE_DEPTH: "full",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
        },
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const outputs = Object.fromEntries(
        readFileSync(output, "utf-8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      const folded = v.parse(
        v.record(v.string(), v.record(v.string(), v.string())),
        JSON.parse(outcomeEnv["FOLDED_SUITES"] ?? ""),
      );
      for (const [job, suites] of Object.entries(folded)) {
        const producer = workflow.jobs[job];
        if (!producer?.if || !producer.outputs) {
          panic(`Missing folded producer: ${job}`);
        }
        const plannedContext = context(event, true, {
          ...heavyPlan,
          ...outputs,
        });
        expect(heavy, `${event}/${job}`).toContain(job);
        expect(selected(producer.if, plannedContext), `${event}/${job}`).toBe(
          true,
        );
        const steps = Object.fromEntries(
          (producer.steps ?? []).flatMap((step) =>
            step.id === undefined
              ? []
              : [
                  [
                    step.id,
                    {
                      outcome: selected(step.if ?? "true", plannedContext)
                        ? "success"
                        : "skipped",
                    },
                  ],
                ],
          ),
        );
        for (const [suite, suiteScope] of Object.entries(suites)) {
          expect(outputs[suiteScope], `${event}/${suite}`).toBe("true");
          const expression = producer.outputs[suite];
          if (expression === undefined) {
            panic(`Missing folded output: ${job}/${suite}`);
          }
          expect(
            evaluateExpression(
              expression,
              contextWithPlanOutputs({
                context: contextFromNested({ ...plannedContext, steps }),
                outputs: planOutputs,
              }),
            ),
            `${event}/${suite}`,
          ).toBe("success");
        }
      }
      for (const key of [
        "desktop_rust_checks_required",
        "docker_checks_required",
        "api_image_smoke_required",
        "e2e_production_required",
        "e2e_core_required",
        "mobile_build_required",
        "route_smoke_required",
        "windows_scripts_required",
      ]) {
        expect(outputs[key], `${event}/${key}`).toBe("true");
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 30_000);

test("main-heavy planning rejects a folded producer excluded by its condition", () => {
  const folded = v.parse(
    v.record(v.string(), v.record(v.string(), v.string())),
    JSON.parse(outcomeEnv["FOLDED_SUITES"] ?? ""),
  );
  for (const job of Object.keys(folded)) {
    const mutated = structuredClone(workflow);
    const producer = mutated.jobs[job];
    if (!producer?.if) {
      panic(`Missing folded producer: ${job}`);
    }
    producer.if = `inputs.heavy_only != true && (${producer.if})`;
    expect(() => mainHeavyJobs(mutated)).toThrow(
      `Folded suites require a main-heavy producer: ${job}`,
    );
  }
});

test("every main heavy event requires the planned compiler to succeed", () => {
  for (const event of heavyEvents) {
    for (const result of [
      "success",
      "failure",
      "skipped",
      "cancelled",
      "timed_out",
    ]) {
      expect(
        evaluate({ event, jobName: "release-typecheck", result }),
        `${event}/${result}`,
      ).toBe(result === "success" ? 0 : 1);
    }
    expect(
      evaluate({
        event,
        jobName: "release-typecheck",
        result: "skipped",
        isPlanned: false,
      }),
      `${event}/unplanned`,
    ).toBe(0);
  }
}, 30_000);

test("heavy failures stay CODE without test-scope evidence even when every queue step passed", async () => {
  const { classifyMainHeavyFailures } =
    await import("./main-heavy-classification.mjs");
  const job = {
    name: "suites / postgres-service-suites (1)",
    conclusion: "failure",
    steps: [
      { name: "Checkout", conclusion: "success" },
      { name: "Run suites", conclusion: "failure" },
    ],
  };
  const queueJob = {
    name: "postgres-service-suites (1)",
    conclusion: "success",
    steps: job.steps.map(({ name }) => ({ name, conclusion: "success" })),
  };
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
  ]) {
    const failures = classifyMainHeavyFailures({
      jobs: [{ ...job, conclusion }],
      queueJobs: [queueJob],
    });
    expect(
      failures.map(({ type }) => type),
      conclusion,
    ).toEqual(["CODE"]);
  }
  const insufficientEvidence = [
    [],
    [{ ...queueJob, name: "postgres-service-suites (2)" }],
    [{ ...queueJob, conclusion: "failure" }],
    [
      {
        ...queueJob,
        steps: queueJob.steps.filter(({ name }) => name !== "Run suites"),
      },
    ],
    [
      {
        ...queueJob,
        steps: queueJob.steps.map((step) =>
          step.name === "Run suites"
            ? { ...step, conclusion: "skipped" }
            : step,
        ),
      },
    ],
  ];
  for (const queueJobs of insufficientEvidence) {
    expect(
      classifyMainHeavyFailures({ jobs: [job], queueJobs }).map(
        ({ type }) => type,
      ),
    ).toEqual(["CODE"]);
  }
  expect(
    classifyMainHeavyFailures({
      jobs: [{ ...job, steps: [] }],
      queueJobs: [queueJob],
    }).map(({ type }) => type),
  ).toEqual(["CODE"]);
  for (const conclusion of ["success", "skipped", "neutral", null]) {
    expect(
      classifyMainHeavyFailures({
        jobs: [{ ...job, conclusion }],
        queueJobs: [queueJob],
      }),
      conclusion ?? "pending",
    ).toEqual([]);
  }
});

test("heavy queue evidence follows Git tree identity and remains conservative when unavailable", async () => {
  const { collectMainHeavyFailures } =
    await import("./main-heavy-classification.mjs");
  const job = {
    name: "suites / code-check",
    conclusion: "failure",
    steps: [{ name: "Check", conclusion: "failure" }],
  };
  const queueJob = {
    name: "code-check",
    conclusion: "success",
    steps: [{ name: "Check", conclusion: "success" }],
  };
  for (const evidence of [
    "matching-tree",
    "different-tree",
    "unavailable",
    "no-run",
  ]) {
    const warnings: string[] = [];
    const github = {
      paginate: async (_method: unknown, options: { run_id: number }) =>
        options.run_id === 100 ? [job] : [queueJob],
      rest: {
        actions: {
          listJobsForWorkflowRun: "current-jobs",
          listJobsForWorkflowRunAttempt: "queue-jobs",
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs:
                evidence === "no-run"
                  ? []
                  : [{ id: 200, head_sha: "queue-commit", run_attempt: 1 }],
            },
          }),
        },
        repos: {
          getCommit: async ({ ref }: { ref: string }) => {
            if (evidence === "unavailable") {
              throw new TypeError("Evidence unavailable");
            }
            return {
              data: {
                commit: {
                  tree: {
                    sha:
                      ref === "tested-commit" || evidence === "matching-tree"
                        ? "same-tree"
                        : "other-tree",
                  },
                },
              },
            };
          },
        },
      },
    };
    const failures = await collectMainHeavyFailures({
      github,
      context: { repo: { owner: "stella", repo: "stella" }, runId: 100 },
      sha: "tested-commit",
      results: { suites: { result: "failure" } },
      warn: (message: string) => {
        warnings.push(message);
      },
    });
    expect(
      failures.map(({ type }) => type),
      evidence,
    ).toEqual(["CODE"]);
    expect(
      failures.at(0)?.reason.includes("test-scope equivalence is unproven"),
      evidence,
    ).toBe(evidence === "matching-tree");
    expect(warnings.length, evidence).toBe(evidence === "unavailable" ? 1 : 0);
  }
});

test("heavy classification uses passing evidence from any matching-tree run", async () => {
  const { collectMainHeavyFailures } =
    await import("./main-heavy-classification.mjs");
  const job = {
    name: "suites / code-check",
    conclusion: "failure",
    steps: [
      { name: "Checkout", conclusion: "success" },
      { name: "Check", conclusion: "failure" },
    ],
  };
  const queueJob = {
    name: "code-check",
    conclusion: "success",
    steps: job.steps.map(({ name }) => ({ name, conclusion: "success" })),
  };
  const evidence = {
    passed: { tree: "same-tree", jobs: [queueJob] },
    failed: {
      tree: "same-tree",
      jobs: [{ ...queueJob, conclusion: "failure" }],
    },
    empty: { tree: "same-tree", jobs: [] },
    checkoutOnly: {
      tree: "same-tree",
      jobs: [{ ...queueJob, steps: queueJob.steps.slice(0, 1) }],
    },
    checkOnly: {
      tree: "same-tree",
      jobs: [{ ...queueJob, steps: queueJob.steps.slice(1) }],
    },
    differentTree: { tree: "other-tree", jobs: [queueJob] },
  };
  for (const [firstKind, first] of Object.entries(evidence)) {
    for (const [secondKind, second] of Object.entries(evidence)) {
      const warnings: string[] = [];
      const github = {
        paginate: async (_method: unknown, { run_id }: { run_id: number }) => {
          if (run_id === 100) {
            return [job];
          }
          return run_id === 200 ? first.jobs : second.jobs;
        },
        rest: {
          actions: {
            listJobsForWorkflowRun: "current-jobs",
            listJobsForWorkflowRunAttempt: "queue-jobs",
            listWorkflowRuns: async () => ({
              data: {
                workflow_runs: [
                  { id: 200, head_sha: "first", run_attempt: 1 },
                  { id: 201, head_sha: "second", run_attempt: 2 },
                ],
              },
            }),
          },
          repos: {
            getCommit: async ({ ref }: { ref: string }) => {
              let tree = "same-tree";
              if (ref === "first") {
                tree = first.tree;
              }
              if (ref === "second") {
                tree = second.tree;
              }
              return { data: { commit: { tree: { sha: tree } } } };
            },
          },
        },
      };
      const failures = await collectMainHeavyFailures({
        github,
        context: { repo: { owner: "stella", repo: "stella" }, runId: 100 },
        sha: "tested-commit",
        results: { suites: { result: "failure" } },
        warn: (message: string) => {
          warnings.push(message);
        },
      });
      const hasQueuePass = firstKind === "passed" || secondKind === "passed";
      expect(
        failures.map(({ type }) => type),
        `${firstKind}/${secondKind}`,
      ).toEqual(["CODE"]);
      expect(
        failures.at(0)?.reason.includes("test-scope equivalence is unproven"),
        `${firstKind}/${secondKind}`,
      ).toBe(hasQueuePass);
      expect(warnings).toEqual([]);
    }
  }
});

test("armed proof cannot replace independent folded suite coverage", () => {
  const folded = v.parse(
    v.record(v.string(), v.unknown()),
    JSON.parse(outcomeEnv["FOLDED_SUITES"] ?? ""),
  );
  for (const name of Object.keys(folded)) {
    const mutated = structuredClone(workflow);
    const job = mutated.jobs[name];
    if (!job?.if) {
      panic(`Missing folded job: ${name}`);
    }
    job.if = `needs.ci-plan.outputs.heavy_proof == 'true' && (${job.if})`;
    expect(() => heavyProofJobScopes(mutated)).toThrow(
      `Folded suites require queued coverage: ${name}`,
    );
  }
});
