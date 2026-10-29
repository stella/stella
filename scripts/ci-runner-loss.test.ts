import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { retryDecision, runnerLost } from "./ci-runner-loss";

const lost = {
  name: "test",
  conclusion: "failure",
  steps: [{ conclusion: "cancelled" }],
};
const failed = {
  name: "lint",
  conclusion: "failure",
  steps: [{ conclusion: "failure" }],
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

test("retryDecision retries runner loss once but preserves real failures", () => {
  const aggregate = { name: "ci-result", conclusion: "failure", steps: [] };
  expect(retryDecision([lost, aggregate], 1).retry).toBe(true);
  expect(retryDecision([lost, aggregate], 2).retry).toBe(false);
  expect(retryDecision([lost, failed, aggregate], 1).retry).toBe(false);
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
    ({ name }) => name === "Retry jobs after runner loss",
  );
  if (step === undefined) {
    panic("Missing runner loss retry step");
  }
  const script = step.with.script;
  const executable = new Script(`(async () => { ${script} })()`);
  const fixtures = [
    { jobs: [lost], attempt: 1 },
    {
      jobs: [lost, { name: "ci-result", conclusion: "failure", steps: [] }],
      attempt: 1,
    },
    { jobs: [lost], attempt: 2 },
    { jobs: [lost, failed], attempt: 1 },
    { jobs: [{ name: "ok", conclusion: "success", steps: [] }], attempt: 1 },
  ];
  for (const fixture of fixtures) {
    let retried = false;
    await executable.runInNewContext({
      github: {
        paginate: async () => fixture.jobs,
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
      core: { summary: { addRaw: () => ({ write: async () => undefined }) } },
    });
    expect(retried).toBe(retryDecision(fixture.jobs, fixture.attempt).retry);
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
