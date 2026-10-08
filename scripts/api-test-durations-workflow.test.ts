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

test("only the plan restores API duration weights by prefix", () => {
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
  const shardRestore = workflowStepByName(
    workflowJobSteps(workflow, "ci-tests"),
    "Restore planned API test durations",
  );
  expect(shardRestore).toMatchObject({
    with: { key: `\${{ needs.ci-plan.outputs.api_test_durations_key }}` },
  });
  expect(Reflect.get(shardRestore.with ?? {}, "restore-keys")).toBeUndefined();
  expect(ciText.match(/restore-keys: api-test-durations-/gu)).toHaveLength(1);
});

test("duration cache saves only after green main API shards", () => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const job = Reflect.get(jobs ?? {}, "api-test-durations");
  const condition = String(Reflect.get(job ?? {}, "if"));
  expect(condition).toContain("github.event_name == 'push'");
  expect(condition).toContain("github.ref == 'refs/heads/main'");
  expect(condition).toContain("needs.ci-tests.result == 'success'");
  expect(condition).not.toContain("pull_request");
  expect(condition).not.toContain("merge_group");
  expect(
    workflowStepByName(
      workflowJobSteps(workflow, "api-test-durations"),
      "Save API test durations",
    ),
  ).toMatchObject({
    with: { key: `api-test-durations-\${{ github.run_id }}` },
  });
});

test("pull request workflows neither write nor require committed duration weights", () => {
  for (const text of [ciText, autofixText]) {
    expect(text).not.toContain("apps/api/scripts/test-durations.json");
    expect(text).not.toContain("--add-missing");
    expect(text).not.toContain("refresh-test-durations.ts --check");
  }
});
