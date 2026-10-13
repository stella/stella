import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkRuleCoverage } from "./check-oxlint-rule-coverage";
import { customLintTestCommand } from "./run-custom-lint-tests";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_FILE = ".github/workflows/ci.yml";
const TEST_DIRECTORY = ".oxlint-plugins/__tests__";
const TEST_STEP = "Custom lint rule coverage";
const TEST_COMMAND = "bun scripts/check-oxlint-rule-coverage.ts";

const workflow = Bun.YAML.parse(
  readFileSync(path.join(REPO_ROOT, WORKFLOW_FILE), "utf-8"),
);

const assertDerivedTestCollection = (run: unknown): void => {
  if (typeof run !== "string" || !run.split("\n").includes(TEST_COMMAND)) {
    throw new Error(
      `${TEST_STEP} must derive the complete test set from ${TEST_DIRECTORY}`,
    );
  }
};

describe("oxlint plugin test collection", () => {
  test("the gating step derives every plugin test from its directory", () => {
    const step = workflowStepByName(
      workflowJobSteps(workflow, "ci-checks-policy"),
      TEST_STEP,
    );

    expect(() => assertDerivedTestCollection(step["run"])).not.toThrow();
    expect(
      [
        ...new Bun.Glob("*.test.ts").scanSync(
          path.join(REPO_ROOT, TEST_DIRECTORY),
        ),
      ].length,
    ).toBeGreaterThan(0);
  });

  test("coverage executes the complete shared fixture command and propagates failure", async () => {
    let executed = false;
    const status = await checkRuleCoverage((command) => {
      executed = true;
      expect(command).toEqual(customLintTestCommand());
      return Bun.spawnSync([process.execPath, "-e", "process.exit(1)"]);
    });
    expect(executed).toBe(true);
    expect(status).toBe(1);
  });

  test("a step with an explicit test list is rejected", () => {
    const plantedRun =
      "bun test ./.oxlint-plugins/__tests__/aggregate-lock-sites.test.ts";

    expect(() => assertDerivedTestCollection(plantedRun)).toThrow(
      "must derive the complete test set",
    );
  });
});
