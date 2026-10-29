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

import { generateMainHeavyInfrastructureSteps } from "./generate-main-heavy-infrastructure-steps";
import { mainHeavyAlertKind } from "./main-heavy-alert-kind.mjs";
import { classifyMainHeavyFailures } from "./main-heavy-classification.mjs";
import { scopeFilters } from "./test-scope";
import { shardFilters } from "./test-shards";

const classificationWorkflow = `jobs:
  fixture:
    name: API release image (\${{ matrix.platform }})
    runs-on: ubuntu-latest
    steps:
      - &checkout
        name: Checkout
        uses: actions/checkout@0000000000000000000000000000000000000000
      - name: Install
        uses: $/.github/actions/ci-install
      - name: Test
        run: bun test
  anchored:
    steps:
      - *checkout
  runner-name:
    steps:
      - name: Set up job
        run: bun test
`;
const classificationDefinitions = JSON.parse(
  await generateMainHeavyInfrastructureSteps(classificationWorkflow),
);

test.each([
  {
    title: "a typed checkout failure is infrastructure",
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: "Checkout", conclusion: "failure" },
      { name: "Test", conclusion: "skipped" },
    ],
    expected: "INFRA",
    name: "suites / API release image (linux/arm64)",
  },
  {
    title: "a run step named Checkout stays code",
    steps: [{ name: "Checkout", conclusion: "failure" }],
    expected: "CODE",
    name: "suites / runner-name",
  },
  {
    title: "a later code failure overrides checkout infrastructure",
    steps: [
      { name: "Checkout", conclusion: "failure" },
      { name: "Test", conclusion: "failure" },
    ],
    expected: "CODE",
    name: "suites / API release image (linux/arm64)",
  },
  {
    title: "a runner setup failure is infrastructure",
    steps: [{ name: "Set up job", conclusion: "failure" }],
    expected: "INFRA",
    name: "suites / API release image (linux/arm64)",
  },
  {
    title: "an anchored checkout step is infrastructure",
    steps: [{ name: "Checkout", conclusion: "failure" }],
    expected: "INFRA",
    name: "suites / anchored",
  },
  {
    title: "a local action with a path prefix is infrastructure",
    steps: [{ name: "Install", conclusion: "failure" }],
    expected: "INFRA",
    name: "suites / API release image (linux/arm64)",
  },
  {
    title: "a user step named Set up job stays code",
    steps: [{ name: "Set up job", conclusion: "failure" }],
    expected: "CODE",
    name: "suites / runner-name",
  },
])("$title", ({ expected, name, steps }) => {
  const failures = classifyMainHeavyFailures({
    jobs: [{ name, conclusion: "failure", steps: [...steps] }],
    queueJobs: [],
    definitions: classificationDefinitions,
  });
  expect(failures.map(({ type }) => type)).toEqual([expected]);
});

const root = path.resolve(import.meta.dirname, "..");

test("the committed infrastructure steps equal a fresh generation", async () => {
  const source = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf-8",
  );
  expect(
    readFileSync(
      path.join(root, "scripts/main-heavy-infrastructure-steps.json"),
      "utf-8",
    ),
  ).toBe(await generateMainHeavyInfrastructureSteps(source));
});

test("the alert classification matches the triggering run status", () => {
  const statuses = [
    {
      context: "main/heavy",
      target_url: "https://github.com/stella/stella/actions/runs/222",
      description: "Main heavy suites: failure (CODE 0, INFRA 2)",
    },
    {
      context: "main/heavy",
      target_url: "https://github.com/stella/stella/actions/runs/111",
      description: "Main heavy suites: failure (CODE 1, INFRA 0)",
    },
  ];
  const classify = (runId: string) =>
    mainHeavyAlertKind(
      [statuses],
      `https://github.com/stella/stella/actions/runs/${runId}`,
      runId,
    );
  expect(classify("111")).toBe("Failed workflow");
  expect(classify("222")).toBe("Infrastructure failure");
  expect(classify("333")).toBe("Failed workflow");
});
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
