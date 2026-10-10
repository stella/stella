import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_FILE = ".github/workflows/ci.yml";
const TEST_DIRECTORY = ".oxlint-plugins/__tests__";
const TEST_STEP = "Test oxlint plugins";
const TEST_COMMAND =
  "find ./.oxlint-plugins/__tests__ -maxdepth 1 -name '*.test.ts' -print0 | sort -z | xargs -0 bun test";

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
      workflowJobSteps(workflow, "ci-checks-rest"),
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

  test("a step with an explicit test list is rejected", () => {
    const plantedRun =
      "bun test ./.oxlint-plugins/__tests__/aggregate-lock-sites.test.ts";

    expect(() => assertDerivedTestCollection(plantedRun)).toThrow(
      "must derive the complete test set",
    );
  });
});
