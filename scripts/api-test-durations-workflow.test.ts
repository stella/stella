import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const ciText = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const autofixText = readFileSync(
  new URL("../.github/workflows/autofix.yml", import.meta.url),
  "utf-8",
);
const workflow: unknown = Bun.YAML.parse(ciText);

const durationJobConditionMatches = (eventName: string) => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const job = Reflect.get(jobs ?? {}, "api-test-durations");
  const condition = String(Reflect.get(job ?? {}, "if"));
  const values: Record<string, boolean> = {
    "github.ref == 'refs/heads/main'": true,
    "github.event_name != 'pull_request'": eventName !== "pull_request",
    "github.event_name != 'merge_group'": eventName !== "merge_group",
    "needs.ci-tests.result == 'success'": true,
    "needs.ci-plan.outputs.api_test_shards != '0'": true,
  };
  return condition.split(/\s*&&\s*/u).every((clause) => values[clause]);
};

test("the plan and aggregator restore API duration weights by prefix", () => {
  const planRestore = workflowStepByName(
    workflowJobSteps(workflow, "ci-plan"),
    "Restore API test durations",
  );
  expect(planRestore).toMatchObject({
    with: {
      key: `api-test-durations-\${{ github.run_id }}`,
      "restore-keys": "api-test-durations-",
    },
  });
  const aggregateRestore = workflowStepByName(
    workflowJobSteps(workflow, "api-test-durations"),
    "Restore previous API test durations",
  );
  expect(aggregateRestore).toMatchObject({
    with: { "restore-keys": "api-test-durations-" },
  });
  expect(ciText.match(/restore-keys: api-test-durations-/gu)).toHaveLength(2);
});

test("duration cache saves only after green main API shards", () => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const job = Reflect.get(jobs ?? {}, "api-test-durations");
  const condition = String(Reflect.get(job ?? {}, "if"));
  expect(condition).toContain("github.ref == 'refs/heads/main'");
  expect(condition).toContain("needs.ci-tests.result == 'success'");
  for (const eventName of ["schedule", "workflow_dispatch", "push"]) {
    expect(durationJobConditionMatches(eventName)).toBeTrue();
  }
  for (const eventName of ["pull_request", "merge_group"]) {
    expect(durationJobConditionMatches(eventName)).toBeFalse();
  }
  expect(
    workflowStepByName(
      workflowJobSteps(workflow, "api-test-durations"),
      "Save API test durations",
    ),
  ).toMatchObject({
    with: { key: `api-test-durations-\${{ github.run_id }}` },
  });
});

test("API shards consume and verify the plan artifact before testing", () => {
  const planSteps = workflowJobSteps(workflow, "ci-plan");
  expect(
    workflowStepByName(planSteps, "Upload planned API test durations"),
  ).toMatchObject({
    with: { name: "api-test-durations-plan", "retention-days": 1 },
  });

  const shardSteps = workflowJobSteps(workflow, "ci-tests");
  expect(
    shardSteps.some(
      (step) =>
        step.name === "Restore planned API test durations" ||
        (String(step.uses).startsWith("actions/cache/restore@") &&
          String(Reflect.get(step.with ?? {}, "path")).includes(
            "api-test-durations",
          )),
    ),
  ).toBeFalse();
  expect(
    workflowStepByName(shardSteps, "Download planned API test durations"),
  ).toMatchObject({ with: { name: "api-test-durations-plan" } });
  const verifyIndex = shardSteps.findIndex(
    (step) => step.name === "Verify planned API test durations",
  );
  const testIndex = shardSteps.findIndex(
    (step) => step.name === "Test API or rest",
  );
  expect(verifyIndex).toBeGreaterThanOrEqual(0);
  expect(verifyIndex).toBeLessThan(testIndex);
  expect(String(shardSteps[verifyIndex]?.run)).toContain("sha256sum");
});

test("API shard cache identity includes and receives the duration hash", () => {
  const turbo: unknown = Bun.JSONC.parse(
    readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
  );
  const tasks = Reflect.get(turbo ?? {}, "tasks");
  const apiTest = Reflect.get(tasks ?? {}, "@stll/api#test");
  expect(Reflect.get(apiTest ?? {}, "env")).toContain(
    "API_TEST_DURATIONS_HASH",
  );
  const testStep = workflowStepByName(
    workflowJobSteps(workflow, "ci-tests"),
    "Test API or rest",
  );
  expect(Reflect.get(testStep.env ?? {}, "API_TEST_DURATIONS_HASH")).toBe(
    `\${{ needs.ci-plan.outputs.api_test_durations_hash }}`,
  );
});

test("pull request workflows neither write nor require committed duration weights", () => {
  for (const text of [ciText, autofixText]) {
    expect(text).not.toContain("apps/api/scripts/test-durations.json");
    expect(text).not.toContain("--add-missing");
    expect(text).not.toContain("refresh-test-durations.ts --check");
  }
});
