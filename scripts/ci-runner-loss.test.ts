import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { INSTALL_STALL_TITLE } from "./ci-install";
import { installStalled, retryDecision, runnerLost } from "./ci-runner-loss";

const lost = {
  id: 1,
  name: "test",
  conclusion: "failure",
  steps: [{ conclusion: "cancelled" }],
};
const failed = {
  id: 2,
  name: "lint",
  conclusion: "failure",
  steps: [{ conclusion: "failure" }],
};
const installSteps = [
  { conclusion: "success", status: "completed" },
  { conclusion: "failure", status: "completed" },
  { conclusion: "skipped", status: "completed" },
];
const stalled = {
  id: 3,
  name: "policy",
  conclusion: "failure",
  steps: installSteps,
  annotations: [
    { title: "" },
    { title: INSTALL_STALL_TITLE },
    { title: "install-budget" },
  ],
};
// An install step failure without the stall annotation is a real failure.
const installFailed = {
  id: 4,
  name: "build",
  conclusion: "failure",
  steps: installSteps,
  annotations: [{ title: "" }],
};
const aggregate = {
  id: 5,
  name: "ci-result",
  conclusion: "failure",
  steps: [],
};

test("runnerLost identifies failures without a failed step", () => {
  expect(runnerLost(lost)).toBe(true);
  expect(runnerLost({ name: "empty", conclusion: "failure", steps: [] })).toBe(
    true,
  );
  expect(runnerLost({ name: "missing", conclusion: "failure" })).toBe(true);
  expect(runnerLost(failed)).toBe(false);
  // Steps not concluded yet (the jobs API catching up) are no evidence of a lost runner.
  expect(
    runnerLost({
      name: "lagging",
      conclusion: "failure",
      steps: [{ conclusion: "success" }, { conclusion: null }],
    }),
  ).toBe(false);
  // A cancelled step next to one still running is not yet evidence either.
  expect(
    runnerLost({
      name: "unfinished",
      conclusion: "failure",
      steps: [
        { conclusion: "cancelled", status: "completed" },
        { conclusion: null, status: "in_progress" },
      ],
    }),
  ).toBe(false);
  for (const conclusion of ["cancelled", "skipped", "success"]) {
    expect(runnerLost({ ...lost, conclusion })).toBe(false);
  }
});

test("installStalled requires the stall annotation on the only failed step", () => {
  expect(installStalled(stalled)).toBe(true);
  expect(installStalled(installFailed)).toBe(false);
  expect(installStalled({ ...stalled, annotations: undefined })).toBe(false);
  // A second failed step is not explained by the stall.
  expect(
    installStalled({
      ...stalled,
      steps: [...installSteps, { conclusion: "failure", status: "completed" }],
    }),
  ).toBe(false);
  expect(
    installStalled({
      ...stalled,
      steps: [...installSteps, { conclusion: null, status: "in_progress" }],
    }),
  ).toBe(false);
  for (const conclusion of ["cancelled", "success"]) {
    expect(installStalled({ ...stalled, conclusion })).toBe(false);
  }
});

const fixtures = [
  { jobs: [lost], attempt: 1, retry: true },
  { jobs: [lost, aggregate], attempt: 1, retry: true },
  { jobs: [lost], attempt: 2, retry: false },
  { jobs: [lost, failed, aggregate], attempt: 1, retry: false },
  { jobs: [stalled, aggregate], attempt: 1, retry: true },
  { jobs: [stalled, lost, aggregate], attempt: 1, retry: true },
  { jobs: [stalled], attempt: 2, retry: false },
  { jobs: [stalled, failed, aggregate], attempt: 1, retry: false },
  { jobs: [installFailed, aggregate], attempt: 1, retry: false },
  { jobs: [stalled, installFailed, aggregate], attempt: 1, retry: false },
  {
    jobs: [{ id: 6, name: "ok", conclusion: "success", steps: [] }],
    attempt: 1,
    retry: false,
  },
];

test("retryDecision retries runner loss or install stalls once but preserves real failures", () => {
  for (const { jobs, attempt, retry } of fixtures) {
    expect(
      retryDecision(jobs, attempt).retry,
      jobs.map(({ name }) => name).join(","),
    ).toBe(retry);
  }
  expect(retryDecision([stalled, aggregate], 1).reason).toBe(
    "install stalled for policy",
  );
  expect(retryDecision([stalled, lost, aggregate], 1).reason).toBe(
    "runner lost for test; install stalled for policy",
  );
  expect(retryDecision([stalled, failed, aggregate], 1).reason).toBe(
    "lint contains a failed step that is not an install stall",
  );
});

test("the retry workflow agrees with retryDecision", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        retry: v.object({
          steps: v.array(
            v.object({
              name: v.string(),
              with: v.object({ script: v.string() }),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL(
          "../.github/workflows/ci-runner-loss-retry.yml",
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  const step = workflow.jobs.retry.steps.find(
    ({ name }) => name === "Retry jobs after runner loss or install stall",
  );
  if (step === undefined) {
    panic("Missing runner loss retry step");
  }
  const script = step.with.script;
  const executable = new Script(`(async () => { ${script} })()`);
  for (const fixture of fixtures) {
    let retried = false;
    let summary = "";
    await executable.runInNewContext({
      github: {
        // The jobs API lists no annotations; the check-runs API serves them.
        paginate: async (
          route: string,
          { check_run_id }: { check_run_id?: number },
        ) =>
          route.endsWith("/annotations")
            ? (fixture.jobs.find(({ id }) => id === check_run_id)
                ?.annotations ?? [])
            : fixture.jobs.map((job) => ({ ...job, annotations: undefined })),
        rest: {
          actions: {
            reRunWorkflowFailedJobs: async () => {
              retried = true;
            },
          },
        },
      },
      context: {
        repo: { owner: "owner", repo: "repo" },
        payload: { workflow_run: { id: 1, run_attempt: fixture.attempt } },
      },
      core: {
        summary: {
          addRaw: (text: string) => {
            summary = text;
            return { write: async () => undefined };
          },
        },
      },
    });
    const decision = retryDecision(fixture.jobs, fixture.attempt);
    expect(retried).toBe(decision.retry);
    expect(summary).toBe(
      `${decision.retry ? "Retried failed jobs" : "Did not retry"}: ${decision.reason}.\n`,
    );
  }
});

// The job also reconciles metadata mirrors, which must follow every attempt's
// outcome, so the retry conditions stay on the retry step.
test("every pull request completion of CI Checks starts the job", () => {
  const source: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci-runner-loss-retry.yml", import.meta.url),
      "utf-8",
    ),
  );
  const parsed = v.parse(
    v.object({ jobs: v.object({ retry: v.object({ if: v.string() }) }) }),
    source,
  );
  const condition = new Script(
    parsed.jobs.retry.if.replaceAll(
      "contains(fromJSON('[\"pull_request\"]'), github.event.workflow_run.event)",
      "github.event.workflow_run.event === 'pull_request'",
    ),
  );
  const starts = (conclusion: string, attempt: number) =>
    condition.runInNewContext({
      github: {
        repository: "owner/repository",
        event: {
          workflow_run: {
            head_repository: { full_name: "owner/repository" },
            path: ".github/workflows/ci.yml",
            event: "pull_request",
            conclusion,
            run_attempt: attempt,
          },
        },
      },
    });
  for (const conclusion of ["failure", "success", "cancelled"]) {
    for (const attempt of [1, 2]) {
      expect(starts(conclusion, attempt), `${conclusion}/${attempt}`).toBe(
        true,
      );
    }
  }
});
