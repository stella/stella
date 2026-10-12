import { describe, expect, test } from "bun:test";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  checkWorkflowYaml,
  parseWorkflowYaml,
  validateActionMetadata,
  actionlintWorkflowSource,
  validateLocalActionReferences,
} from "./check-workflow-yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(import.meta.dirname, "__fixtures__/workflow-yaml");

test("archive action lint rewrites are one-to-one and preserve workflow semantics", () => {
  const source = `jobs:
  check:
    steps:
      - uses: $/.github/actions/ci-install # archive action
        with:
          flags: '["--frozen-lockfile","--ignore-scripts"]'
      - uses: '$/.github/actions/ci-install'
      - run: echo '$/.github/actions/ci-install'
`;
  const normalized = actionlintWorkflowSource({
    source,
    root: ROOT,
    file: "fixture.yml",
  });
  expect(normalized).toBe(
    source.replace("uses: $/", "uses: ./").replace("uses: '$/", "uses: './"),
  );
  expect(source.match(/uses: ['"]?\$\//gu)).toHaveLength(2);
  expect(normalized.match(/uses: ['"]?\.\//gu)).toHaveLength(2);
  expect(normalized).toContain("run: echo '$/.github/actions/ci-install'");
});

test("missing archive targets fail both the workflow guard and lint normalization", () => {
  const source =
    "jobs:\n  check:\n    steps:\n      - uses: $/.github/actions/absent-archive-target\n";
  expect(() =>
    validateLocalActionReferences({
      value: Bun.YAML.parse(source),
      root: ROOT,
      file: "fixture.yml",
    }),
  ).toThrow("must have exactly one metadata file");
  expect(() =>
    actionlintWorkflowSource({
      source,
      root: ROOT,
      file: "fixture.yml",
    }),
  ).toThrow("must have exactly one metadata file");
});

test("archive normalization rejects ambiguous source rewrites and escaping targets", () => {
  const flow =
    "jobs: {check: {steps: [{uses: '$/.github/actions/ci-install'}]}}";
  expect(() =>
    actionlintWorkflowSource({ source: flow, root: ROOT, file: "fixture.yml" }),
  ).toThrow("normalization must be one-to-one");
  const escaping = "jobs:\n  check:\n    steps:\n      - uses: $/../outside\n";
  expect(() =>
    actionlintWorkflowSource({
      source: escaping,
      root: ROOT,
      file: "fixture.yml",
    }),
  ).toThrow("invalid local action");
});

describe("workflow YAML validation", () => {
  test("every repository workflow and action is valid", async () => {
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
    expect(() => validateActionMetadata(action, file)).toThrow(
      `${file}: runs.steps[0] run and shell must be nonempty strings`,
    );
  });

  test("a composite run step with a whitespace-only shell is rejected", () => {
    const action = {
      name: "setup",
      description: "Fixture composite action",
      runs: { using: "composite", steps: [{ run: "echo ok", shell: " " }] },
    };
    expect(() => validateActionMetadata(action, "action.yml")).toThrow(
      "action.yml: runs.steps[0] run and shell must be nonempty strings",
    );
  });

  test.each([
    { using: "node20", main: "index.js" },
    { using: "node24", main: "index.js" },
    { using: "docker", image: "Dockerfile" },
  ])("a $using action does not require composite steps", (runs) => {
    expect(() =>
      validateActionMetadata(
        { name: "setup", description: "Fixture action", runs },
        "action.yml",
      ),
    ).not.toThrow();
  });

  test.each(
    [null, undefined, false, 42, [], {}, "", " "].map((run) => ({ run })),
  )("a composite run value $run is rejected even with a shell", ({ run }) => {
    expect(() =>
      validateActionMetadata(
        {
          name: "setup",
          description: "Fixture composite action",
          runs: { using: "composite", steps: [{ run, shell: "bash" }] },
        },
        "action.yml",
      ),
    ).toThrow(
      "action.yml: runs.steps[0] run and shell must be nonempty strings",
    );
  });

  test("composite run and uses steps retain their distinct requirements", () => {
    expect(() =>
      validateActionMetadata(
        {
          name: "setup",
          description: "Fixture composite action",
          runs: {
            using: "composite",
            steps: [
              { run: "echo ok", shell: "bash" },
              { uses: "actions/checkout@v4" },
            ],
          },
        },
        "action.yml",
      ),
    ).not.toThrow();
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
      `${file}: runs.steps[0] run and shell must be nonempty strings`,
    );
  });
});
