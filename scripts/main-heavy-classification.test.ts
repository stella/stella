import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { classifyMainHeavyFailures } from "./main-heavy-classification.mjs";
import { scopeFilters } from "./test-scope";
import { shardFilters } from "./test-shards";

const classificationWorkflow = `jobs:
  fixture:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@0000000000000000000000000000000000000000
      - name: Test
        run: bun test
`;

test.each([
  {
    title: "a typed checkout failure is infrastructure",
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: "Checkout", conclusion: "failure" },
      { name: "Test", conclusion: "skipped" },
    ],
    expected: "INFRA",
  },
  {
    title: "a run step named Checkout stays code",
    steps: [{ name: "Checkout", conclusion: "failure" }],
    expected: "CODE",
    workflow: `jobs:\n  fixture:\n    steps:\n      - name: Checkout\n        run: bun test\n`,
  },
  {
    title: "a later code failure overrides checkout infrastructure",
    steps: [
      { name: "Checkout", conclusion: "failure" },
      { name: "Test", conclusion: "failure" },
    ],
    expected: "CODE",
  },
  {
    title: "a runner setup failure is infrastructure",
    steps: [{ name: "Set up job", conclusion: "failure" }],
    expected: "INFRA",
  },
])("$title", ({ expected, steps, workflow = classificationWorkflow }) => {
  const failures = classifyMainHeavyFailures({
    jobs: [
      { name: "suites / fixture", conclusion: "failure", steps: [...steps] },
    ],
    queueJobs: [],
    workflow,
  });
  expect(failures.map(({ type }) => type)).toEqual([expected]);
});

const root = path.resolve(import.meta.dirname, "..");
const workflow = v.parse(
  v.object({
    jobs: v.object({
      "ci-tests": v.object({
        steps: v.array(
          v.object({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  ),
);

test("identical queue job and step names cannot prove full and affected test selections equivalent", async () => {
  const steps = workflow.jobs["ci-tests"].steps;
  const affected = v.parse(
    v.string(),
    steps.find(({ name }) => name === "Compute affected flag")?.run,
  );
  const testStep = steps.find(({ name }) => name === "Test API or rest");
  const stepName = v.parse(v.string(), testStep?.name);
  expect(testStep?.run).toContain('read -r -a args <<<"$TEST_SCOPE"');
  expect(testStep?.run).toContain(
    'bun scripts/test-shards.ts --filters "$SHARD"',
  );
  const fixture = mkdtempSync(path.join(tmpdir(), "heavy-selection-proof-"));
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, {
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    const packages = {
      "packages/scripts": {
        name: "@stll/scripts",
        version: "1.0.0",
        scripts: { test: "echo scripts" },
      },
      "packages/ui": {
        name: "@stll/ui",
        version: "1.0.0",
        scripts: { test: "echo ui" },
      },
    };
    // A dependency-free workspace needs no install or lock; root workspace
    // dependencies would make a leaf change invalidate every task globally.
    writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: "scope-fixture",
        private: true,
        packageManager: `bun@${Bun.version}`,
        workspaces: ["packages/*"],
      }),
    );
    writeFileSync(
      path.join(fixture, ".gitignore"),
      "output\nenvironment\n.turbo/\nnode_modules/\n",
    );
    writeFileSync(
      path.join(fixture, "turbo.json"),
      JSON.stringify({ tasks: { test: { cache: false } } }),
    );
    for (const [directory, manifest] of Object.entries(packages)) {
      mkdirSync(path.join(fixture, directory), { recursive: true });
      writeFileSync(
        path.join(fixture, directory, "package.json"),
        JSON.stringify(manifest),
      );
      writeFileSync(
        path.join(fixture, directory, "value.ts"),
        "export const value = 1;\n",
      );
    }
    run(["git", "init", "--quiet", "--initial-branch=main"]);
    run(["git", "config", "user.name", "Fixture"]);
    run(["git", "config", "user.email", "fixture@localhost"]);
    run(["git", "add", "."]);
    run([
      "git",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);
    run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(
      path.join(fixture, "packages/ui/value.ts"),
      "export const value = 2;\n",
    );
    run(["git", "add", "."]);
    run([
      "git",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "ui change",
    ]);
    const tree = run(["git", "rev-parse", "HEAD^{tree}"]);
    const plan = (heavyOnly: boolean) => {
      const output = path.join(fixture, "output");
      const environment = path.join(fixture, "environment");
      writeFileSync(output, "");
      writeFileSync(environment, "");
      const selected = Bun.spawnSync(["bash", "-euc", affected], {
        cwd: fixture,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HEAVY_ONLY: String(heavyOnly),
          EVENT_NAME: heavyOnly ? "push" : "merge_group",
          COMPARISON_BASE: "origin/main",
          TEST_SCOPE: "--filter=...[origin/main...HEAD]",
          GITHUB_OUTPUT: output,
          GITHUB_ENV: environment,
        },
      });
      expect(selected.exitCode, selected.stderr.toString()).toBe(0);
      const flag = readFileSync(output, "utf-8");
      expect(flag).toBe(heavyOnly ? "flag=\n" : "flag=--affected\n");
      const args =
        flag === "flag=\n"
          ? []
          : scopeFilters({
              affected: [],
              base: "origin/main",
              changed: ["packages/ui/value.ts"],
              testInputs: new Map(),
            });
      const filters = shardFilters({
        packageNames: Object.values(packages).map(({ name }) => name),
        shard: "rest",
      });
      const dry = run([
        process.execPath,
        "--bun",
        path.join(root, "node_modules/.bin/turbo"),
        "run",
        "test",
        "--dry=json",
        ...args,
        ...filters,
      ]);
      return v
        .parse(
          v.object({ tasks: v.array(v.object({ taskId: v.string() })) }),
          JSON.parse(dry),
        )
        .tasks.map(({ taskId }) => taskId)
        .toSorted();
    };
    const full = plan(true);
    const scoped = plan(false);
    expect(full).toEqual(["@stll/scripts#test", "@stll/ui#test"]);
    expect(scoped).toEqual(["@stll/ui#test"]);
    expect(scoped).not.toEqual(full);
    expect(run(["git", "rev-parse", "HEAD^{tree}"])).toBe(tree);
    const evidence = {
      jobs: [
        {
          name: "suites / ci-tests (rest-web)",
          conclusion: "failure",
          steps: [{ name: stepName, conclusion: "failure" }],
        },
      ],
      queueJobs: [
        {
          name: "ci-tests (rest-web)",
          conclusion: "success",
          steps: [{ name: stepName, conclusion: "success" }],
        },
      ],
    };
    expect(classifyMainHeavyFailures(evidence).map(({ type }) => type)).toEqual(
      ["CODE"],
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
