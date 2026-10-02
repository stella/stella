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
const mainWorkflow = {
  ...parsedMain,
  jobs: v.parse(
    v.object({ validate: jobSchema, suites: jobSchema, status: jobSchema }),
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
  assertTriggerBehavior(mainWorkflow.jobs.validate.if ?? "true");
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

test("heavy job checkouts and production consumers use the validated SHA", () => {
  for (const job of mainHeavyJobs(ciWorkflow)) {
    const checkout = ciWorkflow.jobs[job]?.steps?.find(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    );
    if (checkout) {
      expect(checkout.with?.["ref"], job).toBe(`\${{ inputs.sha }}`);
    }
  }
  for (const job of ["route-smoke", "e2e-production-shard"]) {
    const stack = ciWorkflow.jobs[job]?.steps?.find(
      ({ uses }) => uses === "./.github/actions/setup-production-e2e",
    );
    expect(stack?.with?.["expected-sha"], job).toBe(
      `\${{ inputs.sha || github.sha }}`,
    );
  }
  expect(ciWorkflow.jobs["marketing-screenshots"]?.with?.["ref"]).toBe(
    `\${{ inputs.sha }}`,
  );
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
  const checkout = marketing.jobs["check"]?.steps?.find(({ uses }) =>
    uses?.startsWith("actions/checkout@"),
  );
  expect(checkout?.with?.["ref"]).toBe(`\${{ inputs.ref }}`);
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
  const statusScript = statusSteps.find(
    ({ name }) => name === "Publish heavy conclusion",
  )?.run;
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

  for (const { validate, suites, expected, exit } of cases) {
    const fixture = mkdtempSync(path.join(tmpdir(), "main-heavy-status-"));
    try {
      const bin = path.join(fixture, "bin");
      const logPath = path.join(fixture, "gh-args");
      const outputPath = path.join(fixture, "github-output");
      const fakeGhPath = path.join(bin, "gh");
      const sha = "c".repeat(40);
      const runUrl = "https://github.example/actions/runs/123";
      const repository = "stella/example";
      const statusPath = `repos/${repository}/statuses/${sha}`;
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
});
