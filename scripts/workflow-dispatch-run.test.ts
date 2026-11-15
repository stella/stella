import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const workflows = new URL("../.github/workflows/", import.meta.url);

// A dispatch names its run only when asked for run details, and may omit it
// even then. Every script that follows a dispatched run asks for the details,
// falls back to finding the run by listing, and never fails because the
// answer named no run.
test("every followed dispatch finds its run without relying on the answer", () => {
  const followers = readdirSync(workflows)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => ({
      name,
      text: readFileSync(new URL(name, workflows), "utf-8"),
    }))
    .filter(({ text }) => text.includes("workflow_run_id"));
  expect(followers.map(({ name }) => name).toSorted()).toEqual([
    "autofix-generated-conflicts.yml",
    "deploy-outlook-addin.yml",
    "marketing-screenshots-update.yml",
  ]);
  for (const { name, text } of followers) {
    expect(text, name).toContain("return_run_details: true");
    expect(text, name).toContain("github.rest.actions.listWorkflowRuns({");
    expect(text, name).toMatch(/created: `>=\$\{since\}`/u);
    expect(text, name).not.toMatch(/returned no run id/u);
  }
});

// A run named by its dispatch can read as Not Found for a moment; the
// follower waits for it rather than failing on the first read, and still
// fails once the run stays missing or the read fails another way.
const followStep = workflowStepByName(
  workflowJobSteps(
    Bun.YAML.parse(
      readFileSync(new URL("deploy-outlook-addin.yml", workflows), "utf-8"),
    ),
    "deploy-staging",
  ),
  "Dispatch deploy-outlook-addin.yml and follow it",
);
const followScript = v.parse(
  v.object({ script: v.string() }),
  followStep["with"],
).script;
const follow = new Script(`(async () => { ${followScript} })()`);

const followDeploy = (reads: readonly (Error | object)[]) => {
  const failures: string[] = [];
  let read = 0;
  const outcome = follow.runInNewContext({
    context: {
      repo: { owner: "stella", repo: "stella" },
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      runId: 1,
    },
    core: {
      notice: () => undefined,
      setFailed: (message: string) => failures.push(message),
    },
    github: {
      rest: {
        actions: {
          createWorkflowDispatch: async () =>
            await Promise.resolve({ data: { workflow_run_id: 42 } }),
          getWorkflowRun: async () => {
            const answer = reads[Math.min(read, reads.length - 1)];
            read += 1;
            if (answer instanceof Error) {
              throw answer;
            }
            return await Promise.resolve({ data: answer });
          },
        },
      },
    },
    process: { env: { DEPLOY_ENVIRONMENT: "staging" } },
    setTimeout: (resolve: () => void) => {
      resolve();
    },
  });
  return { outcome, failures, reads: () => read };
};

const status = (code: number) =>
  Object.assign(new Error(`HTTP ${String(code)}`), { status: code });
const finished = { status: "completed", conclusion: "success" };

test("a followed deploy run waits out a run that is not visible yet", async () => {
  const run = followDeploy([status(404), status(404), finished]);
  await run.outcome;
  expect(run.failures).toEqual([]);
  expect(run.reads()).toBe(3);
});

test("a followed deploy run that stays missing fails the follow", async () => {
  const run = followDeploy([status(404)]);
  expect(await rejectionOf(run.outcome)).toMatchObject({ status: 404 });
  expect(run.reads()).toBeGreaterThan(1);
});

test("a followed deploy run read that fails otherwise is not retried", async () => {
  const run = followDeploy([status(500), finished]);
  expect(await rejectionOf(run.outcome)).toMatchObject({ status: 500 });
  expect(run.reads()).toBe(1);
});
