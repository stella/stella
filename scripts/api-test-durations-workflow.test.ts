import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  workflowCiInstallFlags,
  workflowJobSteps,
  workflowStepByName,
} from "./workflow-steps";

const ciText = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const autofixText = readFileSync(
  new URL("../.github/workflows/autofix.yml", import.meta.url),
  "utf-8",
);
const workflow: unknown = Bun.YAML.parse(ciText);

const durationJobConditionMatches = (
  eventName: string,
  postgresResult = "success",
  cancelled = false,
) => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const job = Reflect.get(jobs ?? {}, "api-test-durations");
  const condition = String(Reflect.get(job ?? {}, "if"));
  const values: Record<string, boolean> = {
    "!cancelled()": !cancelled,
    "inputs.pr_depth_only != true": true,
    "needs.ci-plan.outputs.run_required != 'false'": true,
    "github.ref == 'refs/heads/main'": true,
    "github.event_name != 'pull_request'": eventName !== "pull_request",
    "github.event_name != 'merge_group'": eventName !== "merge_group",
    "needs.ci-tests.result == 'success'": true,
    "(needs.postgres-service-suites.result == 'success' || needs.postgres-service-suites.result == 'skipped')":
      postgresResult === "success" || postgresResult === "skipped",
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
  // Cache-replayed shards upload no timings; the input directory must exist.
  const aggregate = String(
    workflowStepByName(
      workflowJobSteps(workflow, "api-test-durations"),
      "Aggregate API test durations",
    )["run"],
  );
  expect(aggregate).toContain('mkdir -p "$RUNNER_TEMP/api-test-timings"');
  expect(aggregate.indexOf("mkdir")).toBeLessThan(
    aggregate.indexOf("refresh-test-durations.ts"),
  );
  // The aggregator imports API dependencies; a clean runner must install them first.
  const steps = workflowJobSteps(workflow, "api-test-durations");
  const stepIndex = (name: string) =>
    steps.findIndex((step) => step["name"] === name);
  const install = workflowStepByName(steps, "Install API script dependencies");
  expect(workflowCiInstallFlags(install)).toEqual([
    "--frozen-lockfile",
    "--ignore-scripts",
    "--filter",
    "@stll/api",
  ]);
  expect(stepIndex("Install API script dependencies")).toBeGreaterThan(
    stepIndex("Setup Bun"),
  );
  expect(stepIndex("Install API script dependencies")).toBeLessThan(
    stepIndex("Aggregate API test durations"),
  );
});

test("API shards consume and verify the plan artifact before testing", () => {
  const planSteps = workflowJobSteps(workflow, "ci-plan");
  expect(
    workflowStepByName(planSteps, "Upload planned API test durations"),
  ).toMatchObject({
    // A re-run attempt keeps the earlier attempt's artifacts; the plan replaces its own.
    with: {
      name: "api-test-durations-plan",
      overwrite: true,
      "retention-days": 1,
    },
  });

  const shardSteps = workflowJobSteps(workflow, "ci-tests");
  expect(
    shardSteps.some(
      (step) =>
        step["name"] === "Restore planned API test durations" ||
        (String(step["uses"]).startsWith("actions/cache/restore@") &&
          String(Reflect.get(step["with"] ?? {}, "path")).includes(
            "api-test-durations",
          )),
    ),
  ).toBeFalse();
  expect(
    workflowStepByName(shardSteps, "Download planned API test durations"),
  ).toMatchObject({
    run: 'bash scripts/download-run-artifact.sh --name api-test-durations-plan --path "$RUNNER_TEMP"',
  });
  const verifyIndex = shardSteps.findIndex(
    (step) => step["name"] === "Verify planned API test durations",
  );
  const testIndex = shardSteps.findIndex(
    (step) => step["name"] === "Test API or rest",
  );
  expect(verifyIndex).toBeGreaterThanOrEqual(0);
  expect(verifyIndex).toBeLessThan(testIndex);
  expect(String(shardSteps[verifyIndex]?.["run"])).toContain("sha256sum");
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
  expect(Reflect.get(testStep["env"] ?? {}, "API_TEST_DURATIONS_HASH")).toBe(
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

test("Postgres duration weights have a separate immutable planning snapshot", () => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const plan = Reflect.get(jobs ?? {}, "ci-plan");
  expect(Reflect.get(plan ?? {}, "outputs")).toMatchObject({
    postgres_test_durations_hash: `\${{ steps.postgres-test-durations.outputs.hash }}`,
  });
  const steps = workflowJobSteps(workflow, "ci-plan");
  expect(
    workflowStepByName(steps, "Restore Postgres test durations"),
  ).toMatchObject({
    with: {
      path: `\${{ runner.temp }}/postgres-test-durations.json`,
      key: `postgres-test-durations-\${{ github.run_id }}`,
      "restore-keys": "postgres-test-durations-",
    },
  });
  const resolve = String(
    workflowStepByName(steps, "Resolve Postgres test durations")["run"],
  );
  expect(resolve).toContain(
    'sha256sum "$RUNNER_TEMP/postgres-test-durations.json"',
  );
  expect(resolve).toContain('echo "hash=missing"');
  expect(
    workflowStepByName(steps, "Upload planned Postgres test durations"),
  ).toMatchObject({
    with: {
      name: "postgres-test-durations-plan",
      path: `\${{ runner.temp }}/postgres-test-durations.json`,
      overwrite: true,
      "retention-days": 1,
      "if-no-files-found": "ignore",
    },
  });
});

test("duration refresh tolerates skipped Postgres jobs and rejects failed ones", () => {
  const jobs = Reflect.get(workflow ?? {}, "jobs");
  const job = Reflect.get(jobs ?? {}, "api-test-durations");
  expect(Reflect.get(job ?? {}, "needs")).toContain("postgres-service-suites");
  for (const result of ["success", "skipped"]) {
    expect(durationJobConditionMatches("push", result)).toBeTrue();
  }
  for (const result of ["failure", "cancelled"]) {
    expect(durationJobConditionMatches("push", result)).toBeFalse();
  }
  expect(durationJobConditionMatches("push", "success", true)).toBeFalse();
});

test("Postgres durations refresh exclusively from successful service timings", () => {
  const steps = workflowJobSteps(workflow, "api-test-durations");
  for (const name of [
    "Download Postgres test timings",
    "Restore previous Postgres test durations",
    "Aggregate Postgres test durations",
    "Save Postgres test durations",
  ]) {
    expect(workflowStepByName(steps, name)["if"]).toBe(
      "needs.postgres-service-suites.result == 'success'",
    );
  }
  expect(
    workflowStepByName(steps, "Download Postgres test timings"),
  ).toMatchObject({
    run: "bash scripts/download-run-artifact.sh --pattern 'postgres-test-timings-*' --merge --path \"$RUNNER_TEMP/postgres-test-timings\"",
  });
  expect(
    workflowStepByName(steps, "Restore previous Postgres test durations"),
  ).toMatchObject({
    with: { "restore-keys": "postgres-test-durations-" },
  });
  const aggregate = String(
    workflowStepByName(steps, "Aggregate Postgres test durations")["run"],
  );
  expect(aggregate).toContain('mkdir -p "$RUNNER_TEMP/postgres-test-timings"');
  expect(aggregate).toContain(
    'refresh-test-durations.ts --write "$RUNNER_TEMP/postgres-test-durations.json"',
  );
  expect(aggregate).not.toContain("api-test-timings");
  expect(
    workflowStepByName(steps, "Save Postgres test durations"),
  ).toMatchObject({
    with: {
      path: `\${{ runner.temp }}/postgres-test-durations.json`,
      key: `postgres-test-durations-\${{ github.run_id }}`,
    },
  });
});
