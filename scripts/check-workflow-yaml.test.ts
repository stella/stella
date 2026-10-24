import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  actionlintWorkflowSource,
  checkWorkflowYaml,
  parseWorkflowYaml,
  validateActionMetadata,
  validateLocalActionReferences,
  validateNoRubyProcessSpawns,
  validateNoRubyShell,
  validateWorkflowJobTimeouts,
  validateWorkflowSize,
  WORKFLOW_SIZE_LIMIT_BYTES,
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

test("archive normalization preserves scalar spelling, indentation and line endings", () => {
  for (const quote of ["", "'", '"']) {
    for (const newline of ["\n", "\r\n"]) {
      const source = [
        "jobs:",
        "  check:",
        "    steps:",
        `      - uses: ${quote}$/.github/actions/ci-install${quote} # archive`,
        "      - name: padding",
        `        run: echo ${" ".repeat(10_000)}safe`,
        "",
      ].join(newline);
      expect(
        actionlintWorkflowSource({ source, root: ROOT, file: "fixture.yml" }),
      ).toBe(
        source.replace(
          "$/.github/actions/ci-install",
          "./.github/actions/ci-install",
        ),
      );
    }
  }
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

  test("a workflow over the size limit is rejected with its byte count", () => {
    expect(() =>
      validateWorkflowSize(WORKFLOW_SIZE_LIMIT_BYTES, "ci.yml"),
    ).not.toThrow();
    expect(() =>
      validateWorkflowSize(WORKFLOW_SIZE_LIMIT_BYTES + 1, "ci.yml"),
    ).toThrow(
      `ci.yml: ${WORKFLOW_SIZE_LIMIT_BYTES + 1} bytes exceeds the ${WORKFLOW_SIZE_LIMIT_BYTES}-byte workflow size limit`,
    );
  });

  test("Ruby workflow shells and script process spawns are rejected", async () => {
    expect(() =>
      validateNoRubyShell(
        { jobs: { check: { steps: [{ shell: "ruby {0}", run: "puts 1" }] } } },
        "workflow.yml",
      ),
    ).toThrow("workflow.yml: Ruby workflow shells are not allowed");
    for (const shell of [
      "/usr/bin/ruby {0}",
      "/usr/bin/env ruby {0}",
      "env ruby3.3 -w {0}",
    ]) {
      expect(() =>
        validateNoRubyShell(
          { steps: [{ shell, run: "puts 1" }] },
          "workflow.yml",
        ),
      ).toThrow("workflow.yml: Ruby workflow shells are not allowed");
    }
    expect(() =>
      validateNoRubyShell(
        { steps: [{ shell: "bash {0}", run: "true" }] },
        "workflow.yml",
      ),
    ).not.toThrow();

    const root = mkdtempSync(path.join(tmpdir(), "workflow-ruby-spawn-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      const runtime = "ruby";
      writeFileSync(
        path.join(root, "scripts/check.ts"),
        `Bun.spawnSync(["${runtime}", "-e", "puts 1"]);\n`,
      );
      const rejection = await rejectionOf(validateNoRubyProcessSpawns(root));
      expect(rejection instanceof Error ? rejection.message : "").toContain(
        "spawning Ruby from scripts is not allowed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed workflow YAML reports its file", async () => {
    const file = path.join(FIXTURES, "malformed-workflow.yml");
    expect(await rejectionOf(parseWorkflowYaml(file))).toHaveProperty(
      "message",
      `${file}: invalid YAML`,
    );
  });

  test("a step-running job without a timeout names the workflow, job, and rule", async () => {
    const file = path.join(FIXTURES, "missing-job-timeout.yml");
    const workflow = await parseWorkflowYaml(file);
    expect(() => validateWorkflowJobTimeouts(workflow, file)).toThrow(
      `${file}: job missing-timeout runs steps and must define timeout-minutes; every step-running workflow job requires a timeout`,
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
