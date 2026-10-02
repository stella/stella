import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { mainHeavyJobs, THIN_JOBS } from "./main-heavy-plan";

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const jobSchema = v.looseObject({
  if: v.optional(v.string()),
  outputs: v.optional(v.record(v.string(), v.unknown())),
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  uses: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  with: v.optional(v.record(v.string(), v.unknown())),
  secrets: v.optional(v.record(v.string(), v.unknown())),
  steps: v.optional(v.array(stepSchema)),
});
const workflowSchema = v.looseObject({
  name: v.string(),
  on: v.unknown(),
  "run-name": v.optional(v.string()),
  concurrency: v.looseObject({
    group: v.string(),
    "cancel-in-progress": v.union([v.boolean(), v.string()]),
  }),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(v.string(), jobSchema),
});
const mainTriggersSchema = v.object({
  push: v.looseObject({ branches: v.array(v.string()) }),
  schedule: v.array(v.object({ cron: v.string() })),
  workflow_dispatch: v.looseObject({
    inputs: v.record(
      v.string(),
      v.looseObject({
        description: v.optional(v.string()),
        required: v.boolean(),
        type: v.string(),
      }),
    ),
  }),
});
const ciCallSchema = v.object({
  workflow_call: v.looseObject({
    inputs: v.record(
      v.string(),
      v.looseObject({ required: v.optional(v.boolean()), type: v.string() }),
    ),
  }),
});
const readWorkflow = (relativePath: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8"),
    ),
  );
const parsedMain = readWorkflow(".github/workflows/main-heavy.yml");
const callerJobSchema = v.intersect([jobSchema, v.object({ if: v.string() })]);
const mainWorkflow = {
  ...parsedMain,
  jobs: v.parse(
    v.object({
      validate: callerJobSchema,
      suites: callerJobSchema,
      status: callerJobSchema,
    }),
    parsedMain.jobs,
  ),
};
const ciWorkflow = readWorkflow(".github/workflows/ci.yml");
const mainTriggers = v.parse(mainTriggersSchema, mainWorkflow.on);
const ciCall = v.parse(ciCallSchema, ciWorkflow.on).workflow_call;

const assertTriggerBehavior = (validationCondition: string) => {
  const cases = [
    { event: "push", message: "fix: ordinary change", runs: false },
    {
      event: "push",
      message: "fix: ordinary change\nchore: release v1.2.3",
      runs: false,
    },
    {
      event: "push",
      message: "chore: release v1.2.3\n\nRelease notes",
      runs: true,
    },
    { event: "schedule", message: "", runs: true },
    { event: "workflow_dispatch", message: "", runs: true },
  ];
  for (const { event, message, runs } of cases) {
    const context = {
      github: { event_name: event, event: { head_commit: { message } } },
      vars: { MERGE_QUEUE_DEPTH: "" },
      startsWith: (value: string, prefix: string) =>
        value.toLowerCase().startsWith(prefix.toLowerCase()),
      always: () => true,
    };
    const validates = new Script(
      `Boolean(${validationCondition})`,
    ).runInNewContext(context);
    expect(validates, `${event}: ${message}`).toBe(runs);
    expect(mainWorkflow.jobs.suites.needs).toBe("validate");
    const needs = { validate: { result: validates ? "success" : "skipped" } };
    expect(
      new Script(`Boolean(${mainWorkflow.jobs.suites.if})`).runInNewContext({
        ...context,
        needs,
      }),
    ).toBe(runs);
    const publishes = new Script(
      `Boolean(${mainWorkflow.jobs.status.if})`,
    ).runInNewContext({
      ...context,
      needs,
    });
    expect(publishes, `${event} status`).toBe(runs);
  }
};

test("nightly, release pushes and dispatches run suites; ordinary pushes skip suites and status", () => {
  expect(mainTriggers.schedule).toHaveLength(1);
  const cron = mainTriggers.schedule.at(0)?.cron.split(" ");
  expect(cron?.slice(1)).toEqual(["2", "*", "*", "*"]);
  expect(Number(cron?.at(0)) % 5).not.toBe(0);
  expect(
    mainWorkflow.jobs.validate.steps?.find(
      ({ name }) => name === "Validate SHA format",
    )?.env?.["SHA"],
  ).toBe(`\${{ inputs.sha || github.sha }}`);
  assertTriggerBehavior(mainWorkflow.jobs.validate.if);
});

test("dropping the release filter breaks the trigger contract", () => {
  expect(() => assertTriggerBehavior("true")).toThrow(
    "push: fix: ordinary change",
  );
});

test("every main-heavy job has a job-level condition that skips ordinary pushes", () => {
  for (const [name, job] of Object.entries(mainWorkflow.jobs)) {
    expect(typeof job.if, name).toBe("string");
    expect(
      new Script(`Boolean(${job.if})`).runInNewContext({
        vars: { MERGE_QUEUE_DEPTH: "" },
        github: {
          event_name: "push",
          event: { head_commit: { message: "fix: ordinary change" } },
        },
        startsWith: (value: string, prefix: string) =>
          value.toLowerCase().startsWith(prefix.toLowerCase()),
        always: () => true,
        needs: {
          validate: { result: "skipped" },
          suites: { result: "skipped" },
        },
      }),
      name,
    ).toBe(false);
  }
});

test("main heavy workflow dispatches exactly the validated commit through ci.yml's planner", () => {
  expect(mainWorkflow["run-name"]).toBe(
    `Main heavy suites \${{ inputs.sha || github.sha }}`,
  );
  expect(mainTriggers.push.branches).toEqual(["main"]);
  expect(Object.keys(mainTriggers.workflow_dispatch.inputs)).toEqual(["sha"]);
  expect(mainTriggers.workflow_dispatch.inputs["sha"]).toMatchObject({
    required: true,
    type: "string",
  });

  expect(mainWorkflow.concurrency.group).toContain("inputs.sha");
  expect(mainWorkflow.concurrency.group).toContain("github.sha");
  expect(mainWorkflow.concurrency["cancel-in-progress"]).toBe(false);

  const suites = mainWorkflow.jobs.suites;
  expect(suites.uses).toBe("./.github/workflows/ci.yml");
  expect(suites.needs).toBe("validate");
  expect(suites.with).toMatchObject({
    depth: "full",
    heavy_only: true,
    sha: `\${{ needs.validate.outputs.sha }}`,
  });
  expect(mainWorkflow.jobs.validate.outputs?.["sha"]).toBe(
    `\${{ steps.ancestor.outputs.sha }}`,
  );
  expect(ciCall.inputs["heavy_only"]).toMatchObject({
    required: false,
    type: "boolean",
  });
  expect(ciWorkflow.jobs["ci-plan"]?.outputs?.["heavy_jobs"]).toBe(
    `\${{ steps.heavy-plan.outputs.heavy_jobs }}`,
  );
  const plannerStep = ciWorkflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Derive heavy jobs",
  );
  expect(plannerStep?.run).toContain("scripts/main-heavy-plan.ts");
  expect(mainHeavyJobs(ciWorkflow)).not.toHaveLength(0);
  expect(
    THIN_JOBS.every((job) => !mainHeavyJobs(ciWorkflow).includes(job)),
  ).toBe(true);
});

const expressionValue = (value: unknown, context: object) => {
  const expression = v
    .parse(v.string(), value)
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/u, "$1");
  return new Script(
    expression.replaceAll(
      /needs\.([\w-]+)/gu,
      (_, job: string) => `needs[${JSON.stringify(job)}]`,
    ),
  ).runInNewContext(context);
};

type CheckoutWorkflow = v.InferOutput<typeof workflowSchema>;
const heavyCheckoutCensus = (workflow: CheckoutWorkflow) => {
  const outcome = workflow.jobs["ci-result"]?.steps?.find(
    ({ name }) => name === "Evaluate CI outcome",
  );
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(outcome?.env?.["JOB_SCOPES"] ?? ""),
  );
  const plan = {
    ...Object.fromEntries(
      Object.values(scopes).flatMap((scope) =>
        scope === null ? [] : [[scope, "true"]],
      ),
    ),
    trusted: "true",
    suite_depth: "full",
    queue_depth: "full",
    fix_tests_on_base_required: "false",
  };
  const context = {
    inputs: { heavy_only: true, sha: "a".repeat(40) },
    github: {
      sha: "b".repeat(40),
      event_name: "workflow_dispatch",
      event: { pull_request: { draft: false } },
    },
    needs: Object.fromEntries(
      Object.keys(workflow.jobs).map((job) => [
        job,
        {
          result: THIN_JOBS.some((thin) => thin === job)
            ? "skipped"
            : "success",
          outputs: plan,
        },
      ]),
    ),
    always: () => true,
    cancelled: () => false,
  };
  const executed = new Set<string>();
  const visit = (job: string) => {
    if (executed.has(job)) {
      return;
    }
    const body = workflow.jobs[job];
    if (!body) {
      panic(`Missing heavy dependency: ${job}`);
    }
    if (!expressionValue(body.if ?? "true", context)) {
      return;
    }
    executed.add(job);
    const dependencies =
      typeof body.needs === "string" ? [body.needs] : (body.needs ?? []);
    for (const dependency of dependencies) {
      visit(dependency);
    }
  };
  for (const job of mainHeavyJobs(workflow)) {
    visit(job);
  }
  const checkouts = [...executed].flatMap((job) =>
    (workflow.jobs[job]?.steps ?? [])
      .filter(({ uses }) => uses?.startsWith("actions/checkout@"))
      .map((step) => ({ job, step })),
  );
  expect(checkouts.length).toBeGreaterThan(0);
  for (const { job, step } of checkouts) {
    const reference = step.with?.["ref"];
    if (typeof reference !== "string") {
      panic(
        `Missing validated checkout ref: ${job}/${step.name ?? "checkout"}`,
      );
    }
    expect(expressionValue(reference, context), job).toBe(context.inputs.sha);
  }
  return checkouts;
};

test("every executed heavy checkout and dependency targets the validated SHA", () => {
  const checkouts = heavyCheckoutCensus(ciWorkflow);
  expect(checkouts.some(({ job }) => job === "ci-plan")).toBe(true);
  expect(checkouts.some(({ job }) => job === "heavy-web-build")).toBe(true);
  for (const { job, step } of checkouts) {
    const mutant = structuredClone(ciWorkflow);
    const checkout = mutant.jobs[job]?.steps?.find(
      (candidate) =>
        candidate.name === step.name && candidate.uses === step.uses,
    );
    if (!checkout?.with) {
      panic(`Missing checkout mutation fixture: ${job}`);
    }
    delete checkout.with["ref"];
    expect(() => heavyCheckoutCensus(mutant)).toThrow(
      `Missing validated checkout ref: ${job}/`,
    );
  }
});

test("only main heavy forwards its validated SHA while ordinary checkouts use the event ref", () => {
  const validatedSha = "a".repeat(40);
  const eventSha = "b".repeat(40);
  const mainContext = {
    inputs: { heavy_only: true, sha: validatedSha },
    github: { sha: eventSha, workflow: mainWorkflow.name },
  };
  for (const [job, body] of Object.entries(ciWorkflow.jobs)) {
    for (const checkout of body.steps?.filter(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    ) ?? []) {
      const reference = checkout.with?.["ref"];
      if (reference === undefined) {
        continue;
      }
      expect(expressionValue(reference, mainContext), job).toBe(validatedSha);
      for (const event of [
        "pull_request",
        "merge_group",
        "workflow_dispatch",
      ]) {
        expect(
          expressionValue(reference, {
            inputs: { heavy_only: false, sha: validatedSha },
            github: { sha: eventSha, workflow: "CI Checks", event_name: event },
          }),
          job,
        ).toBe("");
      }
    }
  }
  for (const job of ["route-smoke", "e2e-production-shard"]) {
    const stack = ciWorkflow.jobs[job]?.steps?.find(
      ({ uses }) => uses === "./.github/actions/setup-production-e2e",
    );
    expect(
      expressionValue(stack?.with?.["expected-sha"], mainContext),
      job,
    ).toBe(validatedSha);
    expect(
      expressionValue(stack?.with?.["expected-sha"], {
        inputs: { heavy_only: false, sha: validatedSha },
        github: { sha: eventSha },
      }),
      job,
    ).toBe(eventSha);
  }
  const forwarded = ciWorkflow.jobs["marketing-screenshots"]?.with?.["ref"];
  expect(expressionValue(forwarded, mainContext)).toBe(validatedSha);
  expect(
    expressionValue(forwarded, {
      inputs: { heavy_only: false, sha: validatedSha },
    }),
  ).toBe("");
  const marketing = v.parse(
    v.object({ jobs: v.record(v.string(), jobSchema) }),
    Bun.YAML.parse(
      readFileSync(
        new URL(
          "../.github/workflows/marketing-screenshots.yml",
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  const marketingCheckouts =
    marketing.jobs["check"]?.steps?.filter(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    ) ?? [];
  expect(marketingCheckouts.length).toBeGreaterThan(0);
  for (const checkout of marketingCheckouts) {
    expect(
      expressionValue(checkout.with?.["ref"], {
        inputs: { ref: validatedSha },
        github: { workflow: mainWorkflow.name },
      }),
    ).toBe(validatedSha);
    expect(
      expressionValue(checkout.with?.["ref"], {
        inputs: { ref: validatedSha },
        github: { workflow: "CI Checks" },
      }),
    ).toBe("");
  }
});

test("only the final job can publish the main/heavy status", () => {
  expect(mainWorkflow.permissions).toEqual({});
  const jobsWithStatusPermission = Object.entries(mainWorkflow.jobs)
    .filter(([, job]) => job.permissions?.["statuses"] === "write")
    .map(([name]) => name);
  expect(jobsWithStatusPermission).toEqual(["status"]);
  expect(mainWorkflow.jobs.status.permissions).toEqual({ statuses: "write" });
  expect(mainWorkflow.jobs.status.needs).toEqual(["validate", "suites"]);
  const publication = mainWorkflow.jobs.status.steps?.find(
    ({ name }) => name === "Publish heavy conclusion",
  );
  expect(publication?.env?.["RUN_URL"]).toBe(
    `\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}`,
  );
  expect(mainWorkflow.jobs.suites.secrets).toEqual({
    DOCKERHUB_USERNAME: `\${{ secrets.DOCKERHUB_USERNAME }}`,
    DOCKERHUB_TOKEN: `\${{ secrets.DOCKERHUB_TOKEN }}`,
  });
  expect(JSON.stringify(mainWorkflow.jobs)).not.toContain("inherit");
});

test("status step publishes success only when both workflow jobs succeeded", () => {
  const statusSteps = mainWorkflow.jobs.status.steps ?? [];
  const publication = statusSteps.find(
    ({ name }) => name === "Publish heavy conclusion",
  );
  const statusScript = publication?.run;
  if (statusScript === undefined) {
    panic("main-heavy.yml is missing the status publication step");
  }
  const nonSuccessResults = ["failure", "skipped", "cancelled", "timed_out"];
  const cases = [
    { validate: "success", suites: "success", expected: "success", exit: 0 },
    ...nonSuccessResults.flatMap((result) => [
      { validate: result, suites: "success", expected: "failure", exit: 1 },
      { validate: "success", suites: result, expected: "failure", exit: 1 },
    ]),
  ];

  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    for (const { validate, suites, expected, exit } of cases) {
      const fixture = mkdtempSync(path.join(tmpdir(), "main-heavy-status-"));
      try {
        const bin = path.join(fixture, "bin");
        const logPath = path.join(fixture, "gh-args");
        const outputPath = path.join(fixture, "github-output");
        const fakeGhPath = path.join(bin, "gh");
        const validatedSha = "a".repeat(40);
        const eventSha = "b".repeat(40);
        expect(validatedSha).not.toBe(eventSha);
        const sha = v.parse(
          v.string(),
          expressionValue(publication?.env?.["SHA"], {
            github: { sha: eventSha, event_name: event },
            needs: {
              validate: { result: validate, outputs: { sha: validatedSha } },
            },
          }),
        );
        expect(sha, event).toBe(validatedSha);
        const runUrl = "https://github.example/actions/runs/123";
        const repository = "stella/example";
        const statusPath = `repos/${repository}/statuses/${validatedSha}`;
        const results = JSON.stringify({
          validate: { result: validate },
          suites: { result: suites },
        });
        mkdirSync(bin);
        const fakeGh = `#!/bin/sh\nprintf '%s\\n' "$@" >> "$GH_LOG"\n`;
        writeFileSync(fakeGhPath, fakeGh);
        chmodSync(fakeGhPath, 0o755);

        const process = Bun.spawnSync(["bash", "-euc", statusScript], {
          cwd: fixture,
          env: {
            ...Bun.env,
            GH_LOG: logPath,
            GH_TOKEN: "fixture-token",
            GITHUB_OUTPUT: outputPath,
            PATH: `${bin}:${Bun.env["PATH"] ?? ""}`,
            REPOSITORY: repository,
            RESULTS: results,
            RUN_URL: runUrl,
            SHA: sha,
          },
        });
        expect(process.exitCode).toBe(exit);
        const args = readFileSync(logPath, "utf-8").trim().split("\n");
        expect(args).toEqual([
          "api",
          "--method",
          "POST",
          statusPath,
          "-f",
          "context=main/heavy",
          "-f",
          `state=${expected}`,
          "-f",
          `description=Main heavy suites: ${expected}`,
          "-f",
          `target_url=${runUrl}`,
        ]);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  }
}, 30_000);
