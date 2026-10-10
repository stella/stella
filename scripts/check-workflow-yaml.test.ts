import { describe, expect, test } from "bun:test";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  checkWorkflowYaml,
  parseWorkflowYaml,
  validateCompositeAction,
} from "./check-workflow-yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(import.meta.dirname, "__fixtures__/workflow-yaml");

describe("workflow YAML validation", () => {
  test("every repository workflow and composite action is valid", async () => {
    await checkWorkflowYaml(ROOT);
  });

  test("malformed workflow YAML reports its file", async () => {
    const file = path.join(FIXTURES, "malformed-workflow.yml");
    expect(await rejectionOf(parseWorkflowYaml(file))).toHaveProperty(
      "message",
      `${file}: invalid YAML`,
    );
  });

  test("a composite run step without a shell reports its location", async () => {
    const file = path.join(FIXTURES, "broken-action.yml");
    const action = await parseWorkflowYaml(file);
    expect(() => validateCompositeAction(action, file)).toThrow(
      `${file}: runs.steps[0] has run but no shell`,
    );
  });

  test("a composite run step with a whitespace-only shell is rejected", () => {
    const action = {
      name: "setup",
      description: "Fixture composite action",
      runs: { using: "composite", steps: [{ run: "echo ok", shell: " " }] },
    };
    expect(() => validateCompositeAction(action, "action.yml")).toThrow(
      "action.yml: runs.steps[0] has run but no shell",
    );
  });

  test("workflows with the .yaml extension are parsed", async () => {
    const root = path.join(FIXTURES, "yaml-workflow-root");
    const file = path.join(root, ".github/workflows/broken.yaml");
    expect(await rejectionOf(checkWorkflowYaml(root))).toHaveProperty(
      "message",
      `${file}: invalid YAML`,
    );
  });

  test("a composite action may use action.yaml", async () => {
    await checkWorkflowYaml(path.join(FIXTURES, "yaml-action-root"));
  });

  test("a composite action stored as action.yaml is validated", async () => {
    const root = path.join(FIXTURES, "broken-action-yaml-root");
    const file = path.join(root, ".github/actions/setup/action.yaml");
    expect(await rejectionOf(checkWorkflowYaml(root))).toHaveProperty(
      "message",
      `${file}: runs.steps[0] has run but no shell`,
    );
  });
});
