import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { PILOT_ALWAYS, pilotFastJobs } from "./ci-pr-pilot-plan";
import { renderResultInputs } from "./ci-result-inputs";
import { evaluate } from "./github-expression";
import { heavyProofJobs } from "./main-heavy-plan";

const schema = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(
        v.array(
          v.looseObject({
            id: v.optional(v.string()),
            name: v.string(),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
            with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
          }),
        ),
        [],
      ),
    }),
  ),
});
const source = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const workflow = v.parse(schema, Bun.YAML.parse(source));
// Frozen pre-pilot predicates keep the off contract test independent of Git history.
const original = v.parse(
  schema,
  JSON.parse(
    readFileSync(
      new URL("fixtures/ci-pr-pilot-normal-plan.json", import.meta.url),
      "utf-8",
    ),
  ),
);
const planner = workflow.jobs["ci-plan"];
if (!planner) {
  throw new Error("Missing pilot planner");
}
const policy = planner.steps.find((step) => step.id === "pilot")?.with?.script;
if (!policy) {
  throw new Error("Missing pilot policy");
}
const fastJobs = (input: unknown) => {
  const result = pilotFastJobs(input);
  if (result.status === "invalid") {
    throw new Error(result.message);
  }
  return result.jobs;
};
type Options = {
  variable?: string;
  certifiedUntil?: string;
  currentTime?: string;
  event?: string;
  action?: string;
};
const decide = async ({
  variable = "on",
  certifiedUntil = "2026-10-10T12:00:00Z",
  currentTime = "2026-10-09T12:00:00Z",
  event = "pull_request",
  action = "synchronize",
}: Options = {}) => {
  const now = Date.parse(currentTime);
  class FixedDate extends Date {
    static override now = () => now;
  }
  const outputs = new Map<string, string>();
  const notices: string[] = [];
  await new Script(`(async () => {${policy}\n})()`).runInNewContext({
    Date: FixedDate,
    process: {
      env: {
        CI_PR_DEPTH_PILOT: variable,
        CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL: certifiedUntil,
      },
    },
    context: { eventName: event, payload: { action } },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      notice: (message: string) => notices.push(message),
    },
  });
  return { outputs, notices };
};

test("coverage profile requires a current repository certification", async () => {
  const cases = [
    {
      name: "variable off",
      options: { variable: "off" },
      expected: "normal-v1",
    },
    {
      name: "certification missing",
      options: { certifiedUntil: "" },
      expected: "normal-v1",
    },
    {
      name: "certification malformed",
      options: { certifiedUntil: "tomorrow" },
      expected: "normal-v1",
    },
    {
      name: "certification past",
      options: { certifiedUntil: "2026-10-09T11:59:59Z" },
      expected: "normal-v1",
    },
    {
      name: "certification expires now",
      options: { certifiedUntil: "2026-10-09T12:00:00Z" },
      expected: "normal-v1",
    },
    {
      name: "certification too distant",
      options: { certifiedUntil: "2026-10-11T12:00:01Z" },
      expected: "normal-v1",
    },
    {
      name: "certification valid",
      options: { certifiedUntil: "2026-10-11T12:00:00Z" },
      expected: "pilot-fast-v1",
    },
    {
      name: "certification with timezone offset",
      options: {
        certifiedUntil: "2026-10-10T14:00:00+02:00",
        action: "opened",
      },
      expected: "pilot-fast-v1",
    },
    {
      name: "event not pull request",
      options: { event: "push" },
      expected: "normal-v1",
    },
    {
      name: "action not eligible",
      options: { action: "reopened" },
      expected: "normal-v1",
    },
  ] as const;
  for (const { name, options, expected } of cases) {
    const { outputs, notices } = await decide(options);
    expect(outputs.get("coverage_profile"), name).toBe(expected);
    expect(notices, name).toEqual([`coverage_profile=${expected}`]);
  }
});

test("nonexistent calendar dates cannot certify fast coverage", async () => {
  for (const [currentTime, certifiedUntil] of [
    ["2026-02-28T12:00:00Z", "2026-02-29T12:00:00Z"],
    ["2026-02-28T12:00:00Z", "2026-02-30T00:00:00Z"],
    ["2024-02-29T12:00:00Z", "2024-02-30T12:00:00Z"],
    ["2100-02-28T12:00:00Z", "2100-02-29T12:00:00Z"],
    ["2026-04-30T12:00:00Z", "2026-04-31T12:00:00+02:00"],
    ["2026-06-30T12:00:00Z", "2026-06-31T12:00:00Z"],
    ["2026-09-30T12:00:00Z", "2026-09-31T12:00:00Z"],
    ["2026-11-30T12:00:00Z", "2026-11-31T12:00:00Z"],
  ] as const) {
    const expiresAt = Date.parse(certifiedUntil);
    const now = Date.parse(currentTime);
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThanOrEqual(now + 48 * 60 * 60 * 1000);
    const { outputs, notices } = await decide({ currentTime, certifiedUntil });
    expect(outputs.get("coverage_profile"), certifiedUntil).toBe("normal-v1");
    expect(notices).toEqual(["coverage_profile=normal-v1"]);
  }
  for (const year of [2000, 2024]) {
    expect(
      (
        await decide({
          currentTime: `${year}-02-28T12:00:00Z`,
          certifiedUntil: `${year}-02-29T12:00:00Z`,
        })
      ).outputs.get("coverage_profile"),
    ).toBe("pilot-fast-v1");
  }
});

const conditionContext = (
  profile: string,
  event: string,
  depth: string,
  { armed = false }: { armed?: boolean } = {},
) => {
  const values: Record<string, string | boolean | string[]> = {
    "github.event_name": event,
    "github.event.action": "synchronize",
    "github.event.pull_request.draft": false,
    "github.event.pull_request.labels.*.name": [],
    "inputs.heavy_only": false,
    "inputs.pr_depth_only": false,
    "vars.CI_POSTGRES_PR_SELECTION": "",
    "vars.QUEUE_BROWSER_SUITES": "",
    "needs.ci-plan.outputs.coverage_profile": profile,
    "needs.ci-plan.outputs.run_required": "true",
    "needs.ci-plan.outputs.pr_depth_reused": "false",
    "needs.ci-plan.outputs.pilot_fast_jobs": JSON.stringify(fastJobs(workflow)),
    "needs.ci-plan.outputs.suite_depth": depth,
    "needs.ci-plan.outputs.queue_depth": "full",
    "needs.ci-plan.outputs.trusted": "true",
    "needs.ci-plan.outputs.e2e_production_required": "true",
    // A pull request runs the queue-only suites only once armed; a merge
    // group here has no armed proof.
    "needs.ci-plan.outputs.heavy_proof": String(
      event !== "pull_request" || armed,
    ),
  };
  for (const name of Object.keys(workflow.jobs)) {
    values[`needs.${name}.result`] = "success";
  }
  const scopes = source.matchAll(
    // Scope names carry digits (`e2e_landing_required`).
    /needs\.ci-plan\.outputs\.([a-z0-9_]+_required)/gu,
  );
  for (const match of scopes) {
    const scope = match.at(1);
    if (scope === undefined) {
      throw new Error("Missing CI scope capture");
    }
    values[`needs.ci-plan.outputs.${scope}`] = "true";
  }
  values["needs.ci-plan.outputs.corpus_suites_required"] = "false";
  values["needs.ci-plan.outputs.postgres_service_suites_required"] =
    event === "pull_request" ? "false" : "true";
  return {
    values,
    status: { always: true, success: true, failure: false, cancelled: false },
  };
};

// Suites a pull request runs only once armed (the heavy_proof gate).
const queueOnly = new Set(heavyProofJobs(workflow));

const DECLARED_NORMAL_PLAN_CHANGES = new Set([
  "e2e-production-shard",
  "web-build",
  "scan-engine-wasm-drift",
]);
// Jobs that now also run at fast depth: on a pull request they run, and every
// other event keeps the plan its former predicate had at full depth.
const DECLARED_EVERY_DEPTH_CHANGES = new Set(["e2e-landing"]);

// Jobs that became parts of one shared job: the part's steps, under the
// shared job's condition, keep the job's former plan.
const FOLDED_PARTS = new Map([
  ["parser-version-guard", "pr-heavy-gate"],
  ["ci-checks-docs", "pr-heavy-gate"],
  ["dated-waiver-expiry", "pr-heavy-gate"],
]);
const partSelected = (
  name: string,
  context: ReturnType<typeof conditionContext>,
) => {
  const host = FOLDED_PARTS.get(name);
  if (host === undefined) {
    return evaluate(workflow.jobs[name]?.if ?? "true", context);
  }
  const installed = {
    ...context,
    values: { ...context.values, "steps.install.outcome": "success" },
  };
  const hosts = [host, "ci-quick-checks"];
  const selectedHost = hosts.find(
    (candidate) =>
      evaluate(workflow.jobs[candidate]?.if ?? "true", installed) === true,
  );
  if (selectedHost === undefined) {
    return false;
  }
  const parts = (workflow.jobs[selectedHost]?.steps ?? []).filter((step) =>
    step.name.startsWith(`${name}: `),
  );
  expect(parts.length, name).toBeGreaterThan(0);
  return parts.every((step) => evaluate(step.if ?? "true", installed) === true);
};

test("off and unset preserve today's job plan across every event and depth", async () => {
  expect(
    [
      ...new Set([
        ...Object.keys(original.jobs).map(
          (job) => FOLDED_PARTS.get(job) ?? job,
        ),
        "postgres-service-suites",
        "generated-sources",
        "ci-quick-checks",
        "code-quality-api-cancel",
        "code-quality-web-rest-cancel",
        "autofix-dispatch",
        "pr-heavy-gate",
      ]),
    ].toSorted(),
  ).toEqual(
    Object.keys(workflow.jobs)
      .filter((job) => job !== "query-perf")
      .toSorted(),
  );
  for (const variable of ["", "off"]) {
    for (const event of [
      "pull_request",
      "merge_group",
      "workflow_dispatch",
      "push",
    ]) {
      for (const action of [
        "opened",
        "synchronize",
        "reopened",
        "labeled",
        "unlabeled",
        "ready_for_review",
        "auto_merge_enabled",
        "enqueued",
      ]) {
        const { outputs } = await decide({ variable, event, action });
        expect(outputs.get("coverage_profile")).toBe("normal-v1");
        for (const depth of ["fast", "full"]) {
          // The normal PR plan is the armed run's plan; an unarmed push
          // leaves out exactly the queue-only suites.
          const context = conditionContext("normal-v1", event, depth, {
            armed: true,
          });
          if (event === "pull_request") {
            const unarmed = conditionContext("normal-v1", event, depth);
            for (const name of queueOnly) {
              expect(
                evaluate(workflow.jobs[name]?.if ?? "true", unarmed),
                name,
              ).toBe(false);
            }
          }
          for (const [name, job] of Object.entries(original.jobs)) {
            if (DECLARED_EVERY_DEPTH_CHANGES.has(name)) {
              const actual = evaluate(
                workflow.jobs[name]?.if ?? "true",
                context,
              );
              const baseline = evaluate(
                job.if ?? "true",
                conditionContext("normal-v1", event, "full", { armed: true }),
              );
              expect(actual, name).toBe(
                event === "pull_request" ? true : baseline,
              );
              continue;
            }
            if (DECLARED_NORMAL_PLAN_CHANGES.has(name)) {
              const actual = evaluate(
                workflow.jobs[name]?.if ?? "true",
                context,
              );
              const baseline = evaluate(job.if ?? "true", context);
              expect(actual, name).toBe(
                event === "pull_request" ? true : baseline,
              );
              continue;
            }
            const planned = evaluate(job.if ?? "true", context);
            // Arming adds the queue-only suites to the normal PR plan.
            if (event === "pull_request" && queueOnly.has(name)) {
              if (planned === true) {
                expect(partSelected(name, context), name).toBe(true);
              }
              continue;
            }
            expect(partSelected(name, context), name).toEqual(planned);
          }
        }
      }
    }
  }
  expect([...DECLARED_NORMAL_PLAN_CHANGES]).toEqual([
    "e2e-production-shard",
    "web-build",
    "scan-engine-wasm-drift",
  ]);
  expect([...DECLARED_EVERY_DEPTH_CHANGES]).toEqual(["e2e-landing"]);
});

test("Postgres PR execution follows explicit opt-in in either pilot profile", () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const selection of ["", "off", "on"]) {
      const context = conditionContext(profile, "pull_request", "fast", {
        armed: true,
      });
      context.values["vars.CI_POSTGRES_PR_SELECTION"] = selection;
      context.values["needs.ci-plan.outputs.postgres_service_suites_required"] =
        String(selection === "on");
      expect(
        evaluate(
          workflow.jobs["postgres-service-suites"]?.if ?? "false",
          context,
        ),
      ).toBe(selection === "on");
    }
  }
});

test("corpus-only PRs start only corpus service steps", () => {
  const context = conditionContext("normal-v1", "pull_request", "fast", {
    armed: true,
  });
  for (const key of Object.keys(context.values)) {
    if (key.endsWith("_required")) {
      context.values[key] = "false";
    }
  }
  context.values["needs.ci-plan.outputs.run_required"] = "true";
  context.values["needs.ci-plan.outputs.service_suites_required"] = "true";
  context.values["needs.ci-plan.outputs.corpus_suites_required"] = "true";
  const service = workflow.jobs["service-suites"];
  expect(evaluate(service?.if ?? "false", context)).toBe(true);
  const selectedSteps = (service?.steps ?? [])
    .filter((step) => evaluate(step.if ?? "true", context))
    .map((step) => step.name);
  expect(selectedSteps).toContain("Run corpus engine suites");
  expect(selectedSteps).not.toContain("Run Postgres-gated API suites");
  expect(
    evaluate(workflow.jobs["postgres-service-suites"]?.if ?? "false", context),
  ).toBe(false);
  expect(selectedSteps).not.toContain("Run Valkey-gated API suites");
});

test("docs-only PRs retain Markdown checks in every pilot coverage profile", () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    const context = conditionContext(profile, "pull_request", "fast");
    for (const key of Object.keys(context.values)) {
      if (key.endsWith("_required")) {
        context.values[key] = "false";
      }
    }
    context.values["needs.ci-plan.outputs.run_required"] = "true";
    context.values["needs.ci-plan.outputs.docs_checks_required"] = "true";
    context.values["steps.install.outcome"] = "success";
    const scheduled = Object.entries(workflow.jobs)
      .filter(([name]) => !["ci-plan", "ci-result"].includes(name))
      .filter(([, job]) => evaluate(job.if ?? "true", context) === true)
      .map(([name]) => name);
    expect(scheduled).toEqual([...PILOT_ALWAYS]);
    // The Markdown checks are a part of the always-run quick checks.
    const docs = (workflow.jobs["pr-heavy-gate"]?.steps ?? []).filter((step) =>
      step.name.startsWith("ci-checks-docs: "),
    );
    expect(docs).toHaveLength(1);
    for (const step of docs) {
      expect(evaluate(step.if ?? "true", context), profile).toBe(true);
    }
  }
});

test("Docker checks retain every queue depth in both coverage profiles", () => {
  expect(fastJobs(workflow)).not.toContain("docker-checks");
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const queueDepth of ["thin", "full"]) {
      const context = conditionContext(profile, "merge_group", "full");
      context.values["needs.ci-plan.outputs.queue_depth"] = queueDepth;
      context.values["needs.ci-plan.outputs.run_required"] = "false";
      expect(
        evaluate(workflow.jobs["docker-checks"]?.if ?? "false", context),
      ).toBe(true);
      context.values["needs.ci-plan.outputs.docker_checks_required"] = "false";
      expect(
        evaluate(workflow.jobs["docker-checks"]?.if ?? "false", context),
      ).toBe(false);
    }
  }
});

test("desktop Rust tests retain merge-group selection in every coverage profile and queue depth", () => {
  expect(fastJobs(workflow)).not.toContain("desktop-rust-tests");
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const event of ["pull_request", "merge_group"]) {
      for (const queueDepth of ["thin", "full"]) {
        for (const required of ["true", "false"]) {
          const context = conditionContext(profile, event, "full");
          context.values["needs.ci-plan.outputs.queue_depth"] = queueDepth;
          context.values["needs.ci-plan.outputs.desktop_rust_checks_required"] =
            required;
          expect(
            evaluate(
              workflow.jobs["desktop-rust-tests"]?.if ?? "false",
              context,
            ),
            `${profile}/${event}/${queueDepth}/${required}`,
          ).toBe(event === "merge_group" && required === "true");
        }
      }
    }
  }
});

test("desktop Rust lint retains both platforms in every PR coverage profile and queue depth", () => {
  expect(fastJobs(workflow)).toContain("desktop-rust-lint");
  expect(fastJobs(workflow)).not.toContain("desktop-rust-tests");
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const event of ["pull_request", "merge_group"]) {
      for (const queueDepth of ["thin", "full"]) {
        const context = conditionContext(
          profile,
          event,
          event === "pull_request" ? "fast" : "full",
        );
        context.values["needs.ci-plan.outputs.queue_depth"] = queueDepth;
        expect(
          evaluate(workflow.jobs["desktop-rust-lint"]?.if ?? "false", context),
        ).toBe(true);
        context.values["needs.ci-plan.outputs.desktop_rust_checks_required"] =
          "false";
        expect(
          evaluate(workflow.jobs["desktop-rust-lint"]?.if ?? "false", context),
        ).toBe(false);
      }
    }
  }
});

test("pilot pushes execute only the fast allowlist and its generated-input prerequisite", async () => {
  const { outputs } = await decide();
  expect(outputs.get("coverage_profile")).toBe("pilot-fast-v1");
  const allowed = fastJobs(workflow);
  const context = conditionContext("pilot-fast-v1", "pull_request", "fast");
  const always: readonly string[] = PILOT_ALWAYS;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (always.includes(name)) {
      expect(evaluate(job.if ?? "true", context), name).toBe(true);
      continue;
    }
    if (!allowed.includes(name)) {
      expect(evaluate(job.if ?? "true", context), name).toBe(false);
    }
    // A pilot push is unarmed: the queue-only suites wait for arming.
    if (queueOnly.has(name)) {
      expect(evaluate(job.if ?? "true", context), name).toBe(false);
      continue;
    }
    if (
      allowed.includes(name) &&
      !name.endsWith("-cancel") &&
      name !== "autofix-dispatch" &&
      evaluate(
        original.jobs[name]?.if ?? "true",
        conditionContext("normal-v1", "pull_request", "fast"),
      ) === true
    ) {
      expect(evaluate(job.if ?? "true", context), name).toBe(true);
    }
    if (!allowed.includes(name) || name === "ci-result") {
      continue;
    }
    const needs =
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    for (const prerequisite of needs) {
      expect(allowed, name).toContain(prerequisite);
    }
  }
});

test("ready and auto-merge arm select exactly the normal PR plan", async () => {
  for (const action of ["ready_for_review", "auto_merge_enabled"]) {
    const { outputs } = await decide({ action });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
  }
  // Arming runs the queue-only suites with the normal PR plan.
  const full = conditionContext("normal-v1", "pull_request", "fast", {
    armed: true,
  });
  const reference = conditionContext("normal-v1", "pull_request", "fast", {
    armed: true,
  });
  for (const [name, job] of Object.entries(original.jobs)) {
    if (evaluate(job.if ?? "true", reference) === true) {
      expect(evaluate(workflow.jobs[name]?.if ?? "true", full), name).toBe(
        true,
      );
    }
  }
});

test("main and queue ignore the pilot switch", async () => {
  for (const event of ["merge_group", "push", "workflow_dispatch"]) {
    const { outputs } = await decide({ event });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
  }
});

test("the prerequisite census rejects every undecided new job and every deferred dependency", () => {
  expect(fastJobs(workflow)).toContain("ci-checks-generated");
  expect(
    pilotFastJobs({ jobs: { ...workflow.jobs, future: {} } }),
  ).toMatchObject({
    status: "invalid",
    message: "Unclassified pilot job: future",
  });
  for (const dependency of [
    "api-image-smoke",
    "web-build",
    "ci-browser",
    "service-suites",
    "postgres-service-suites",
  ]) {
    expect(
      pilotFastJobs({
        jobs: {
          ...workflow.jobs,
          "ci-tests": { needs: ["ci-plan", dependency] },
        },
      }),
    ).toMatchObject({
      status: "invalid",
      message: `Pilot prerequisite is deferred: ${dependency}`,
    });
  }
});

test("pilot-fast aggregation requires its planned jobs and accepts deferred skips", () => {
  const result = workflow.jobs["ci-result"];
  const aggregation = result?.steps.find(
    (step) => step.name === "Evaluate CI outcome",
  );
  if (!aggregation?.run || !aggregation.env || !Array.isArray(result?.needs)) {
    throw new Error("Missing result aggregation contract");
  }
  const run = aggregation.run;
  const selected = fastJobs(workflow);
  expect(selected).toContain("ci-plan");
  expect(selected).toContain("ci-result");
  expect(result.needs).not.toContain("ci-result");
  const selectedDependencies = result.needs.filter((job) =>
    selected.includes(job),
  );
  const deferredDependencies = result.needs.filter(
    (job) => !selected.includes(job),
  );
  expect(selectedDependencies.length).toBeGreaterThan(1);
  expect(deferredDependencies.length).toBeGreaterThan(0);
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(aggregation.env["JOB_SCOPES"] ?? "null"),
  );
  const plan = Object.fromEntries(
    Object.values(scopes)
      .filter((scope) => scope !== null)
      .map((scope) => [scope, "true"]),
  );
  const successful = Object.fromEntries(
    result.needs.map((job) => [
      job,
      { result: selected.includes(job) ? "success" : "skipped" },
    ]),
  );
  const aggregate = (needs: typeof successful) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        renderResultInputs(run, {
          needs: JSON.stringify(needs),
          plan: JSON.stringify(plan),
        }),
      ],
      {
        env: {
          ...process.env,
          ...aggregation.env,
          COVERAGE_PROFILE: "pilot-fast-v1",
          PILOT_FAST_JOBS: JSON.stringify(selected),
          PLAN_RESULT: "success",
          TRUSTED: "true",
          EVENT: "pull_request",
          SUITE_DEPTH: "fast",
          QUEUE_DEPTH: "full",
          QUEUE_VALIDATION: "false",
          HEAVY_ONLY: "false",
          RUN_REQUIRED: "true",
        },
      },
    );
  // ci-result remains in the profile but is absent from its own dependency map.
  expect(successful).not.toHaveProperty("ci-result");
  const passed = aggregate(successful);
  expect(passed.exitCode, passed.stderr.toString()).toBe(0);
  for (const job of selectedDependencies) {
    for (const outcome of ["skipped", "failure"]) {
      const failed = aggregate({ ...successful, [job]: { result: outcome } });
      expect(
        failed.exitCode,
        `${job}/${outcome}: ${failed.stdout.toString()}`,
      ).toBe(1);
    }
  }
});

test("scan engine builds offline on affected PRs in both coverage profiles", () => {
  const condition = workflow.jobs["scan-engine-wasm-drift"]?.if;
  if (!condition) {
    throw new Error("Missing scan engine condition");
  }
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const required of ["false", "true"]) {
      for (const trusted of ["false", "true"]) {
        const context = conditionContext(profile, "pull_request", "fast");
        context.values["needs.ci-plan.outputs.scan_engine_wasm_required"] =
          required;
        context.values["needs.ci-plan.outputs.trusted"] = trusted;
        expect(evaluate(condition, context)).toBe(
          required === "true" && trusted === "true",
        );
      }
    }
  }
  expect(fastJobs(workflow)).toContain("scan-engine-wasm-drift");
});
