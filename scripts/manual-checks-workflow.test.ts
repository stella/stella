import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { validateManualCheckInput } from "./manual-check-input";

const workflowFile = new URL(
  "../.github/workflows/manual-checks.yml",
  import.meta.url,
);
const workflowText = readFileSync(workflowFile, "utf-8");
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const workflowSchema = v.looseObject({
  on: v.record(v.string(), v.unknown()),
  permissions: v.unknown(),
  concurrency: v.looseObject({ group: v.string() }),
  jobs: v.looseObject({
    check: v.looseObject({ steps: v.array(stepSchema) }),
  }),
});
const parseWorkflow = (text: string) =>
  v.parse(workflowSchema, Bun.YAML.parse(text));

const workflowProblems = (text: string): string[] => {
  const workflow = parseWorkflow(text);
  const problems: string[] = [];
  if (
    JSON.stringify(Object.keys(workflow.on)) !==
    JSON.stringify(["workflow_dispatch"])
  ) {
    problems.push("trigger");
  }
  const options = v.parse(
    v.looseObject({
      inputs: v.looseObject({
        check: v.looseObject({ options: v.array(v.string()) }),
      }),
    }),
    workflow.on["workflow_dispatch"],
  ).inputs.check.options;
  if (
    JSON.stringify(options) !==
    JSON.stringify([
      "typecheck-repo",
      "typecheck-package",
      "lint",
      "test-files",
      "verify-affected",
    ])
  ) {
    problems.push("enum");
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify({ contents: "read" })
  ) {
    problems.push("permissions");
  }
  if (/\bsecrets\s*\./u.test(text)) {
    problems.push("encrypted-values");
  }
  for (const step of workflow.jobs.check.steps) {
    if (typeof step.run === "string" && /\$\{\{\s*inputs\./u.test(step.run)) {
      problems.push("inline-input");
    }
  }
  if (workflow.jobs.check.steps.at(0)?.name !== "Refuse protected refs") {
    problems.push("refusal-first");
  }
  if (
    workflow.concurrency.group !==
    `manual-check-\${{ github.ref }}-\${{ inputs.check }}`
  ) {
    problems.push("concurrency");
  }
  const upload = workflow.jobs.check.steps.find(
    (step) => step.name === "Upload result",
  );
  if (upload?.with?.["name"] !== "manual-check-result") {
    problems.push("artifact");
  }
  return problems;
};

test("workflow preserves the dispatch-only least-privilege contract", () => {
  expect(workflowProblems(workflowText)).toEqual([]);
  const mutations: [string, string, string][] = [
    [
      "trigger",
      "on:\n  workflow_dispatch:",
      "on:\n  pull_request: {}\n  workflow_dispatch:",
    ],
    [
      "encrypted-values",
      "permissions:\n",
      `env:\n  BAD: \${{ secrets.VALUE }}\n\npermissions:\n`,
    ],
    [
      "inline-input",
      "          bun scripts/manual-check-input.ts 2>&1",
      `          echo "\${{ inputs.target }}"\n          bun scripts/manual-check-input.ts 2>&1`,
    ],
    [
      "permissions",
      "  contents: read\n\nconcurrency:",
      "  contents: read\n  actions: read\n\nconcurrency:",
    ],
    ["enum", "          - verify-affected", "          - unknown-check"],
    [
      "refusal-first",
      "      - name: Refuse protected refs",
      "      - name: Refusal moved",
    ],
    [
      "concurrency",
      `group: manual-check-\${{ github.ref }}-\${{ inputs.check }}`,
      `group: manual-check-\${{ github.ref }}`,
    ],
    [
      "artifact",
      "name: manual-check-result\n          path:",
      "name: wrong-result\n          path:",
    ],
  ];
  for (const [problem, before, after] of mutations) {
    const mutated = workflowText.replace(before, () => after);
    expect(mutated).not.toBe(workflowText);
    expect(workflowProblems(mutated)).toContain(problem);
  }
});

test("result writer emits the stable result shape and first twenty errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "manual-check-result-"));
  const log = path.join(directory, "check.log");
  const exit = path.join(directory, "check.exit");
  const start = path.join(directory, "check.start");
  const summary = path.join(directory, "summary.md");
  writeFileSync(
    log,
    Array.from({ length: 22 }, (_, index) => `error ${index}`).join("\n"),
  );
  writeFileSync(exit, "7\n");
  writeFileSync(start, `${Math.floor(Date.now() / 1000) - 2}\n`);
  const run = Bun.spawnSync(
    ["bun", new URL("write-manual-check-result.ts", import.meta.url).pathname],
    {
      cwd: directory,
      env: {
        ...process.env,
        CHECK_SHA: "a".repeat(40),
        CHECK_REF: "refs/heads/feature",
        CHECK_CHECK: "lint",
        CHECK_TARGET: "",
        CHECK_LOG_FILE: log,
        CHECK_EXIT_FILE: exit,
        CHECK_START_FILE: start,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  expect(run.exitCode).toBe(0);
  const raw = readFileSync(
    path.join(directory, "manual-check-result.json"),
    "utf-8",
  );
  const result = JSON.parse(raw);
  expect(result).toEqual({
    version: 1,
    sha: "a".repeat(40),
    ref: "refs/heads/feature",
    check: "lint",
    target: "",
    exit: 7,
    seconds: expect.any(Number),
    failures: Array.from({ length: 20 }, (_, index) => `error ${index}`),
  });
  expect(readFileSync(summary, "utf-8")).toBe(raw);
});

type WriteResultFiles = { log?: string; exit?: string; start?: string };
const writeResult = (files: WriteResultFiles) => {
  const directory = mkdtempSync(path.join(tmpdir(), "manual-check-result-"));
  const paths = {
    log: path.join(directory, "check.log"),
    exit: path.join(directory, "check.exit"),
    start: path.join(directory, "check.start"),
  };
  for (const key of ["log", "exit", "start"] as const) {
    const content = files[key];
    if (content !== undefined) {
      writeFileSync(paths[key], content);
    }
  }
  const run = Bun.spawnSync(
    ["bun", new URL("write-manual-check-result.ts", import.meta.url).pathname],
    {
      cwd: directory,
      env: {
        ...process.env,
        CHECK_SHA: "a".repeat(40),
        CHECK_REF: "refs/heads/feature",
        CHECK_CHECK: "test-files",
        CHECK_TARGET: "apps/x.test.ts",
        CHECK_LOG_FILE: paths.log,
        CHECK_EXIT_FILE: paths.exit,
        CHECK_START_FILE: paths.start,
      },
    },
  );
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(
    readFileSync(path.join(directory, "manual-check-result.json"), "utf-8"),
  );
};

test("result writer keeps bun test failures and refused inputs", () => {
  expect(
    writeResult({
      log: "(pass) one\n(fail) parses dates [1.2ms]\n",
      exit: "1\n",
      start: `${Math.floor(Date.now() / 1000)}\n`,
    }).failures,
  ).toEqual(["(fail) parses dates [1.2ms]"]);
  // The validate step records a refusal exactly like a failed check.
  expect(
    writeResult({
      log: "::error::invalid test file path: apps/x.spec.js\n",
      exit: "1\n",
      start: `${Math.floor(Date.now() / 1000)}\n`,
    }),
  ).toMatchObject({
    exit: 1,
    failures: ["::error::invalid test file path: apps/x.spec.js"],
  });
});

test("a silent successful check reports no failures", () => {
  expect(
    writeResult({
      log: "",
      exit: "0\n",
      start: `${Math.floor(Date.now() / 1000)}\n`,
    }),
  ).toMatchObject({ exit: 0, failures: [] });
});

test("result writer reports a check that never ran as a failure", () => {
  expect(writeResult({})).toMatchObject({
    exit: 1,
    seconds: 0,
    failures: ["error: a setup step failed before the check ran"],
  });
});

const runTestFiles = (script: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "manual-check-run-"));
  const marker = (dir: string) => path.join(directory, dir, "ran");
  for (const dir of ["apps", "fixtures/apps"]) {
    mkdirSync(path.join(directory, dir), { recursive: true });
    writeFileSync(
      path.join(directory, dir, "x.test.ts"),
      `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("ran", () => writeFileSync(${JSON.stringify(marker(dir))}, ""));\n`,
    );
  }
  const run = Bun.spawnSync(["bash", "-e", "-c", script], {
    cwd: directory,
    env: {
      ...process.env,
      CHECK_CHECK: "test-files",
      CHECK_TARGET: "apps/x.test.ts",
      CHECK_LOG_FILE: path.join(directory, "check.log"),
      CHECK_EXIT_FILE: path.join(directory, "check.exit"),
      CHECK_START_FILE: path.join(directory, "check.start"),
    },
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return {
    requested: existsSync(marker("apps")),
    suffixTwin: existsSync(marker("fixtures/apps")),
  };
};

test("test-files runs exactly the listed files, not files sharing a path suffix", () => {
  const script = v.parse(
    v.string(),
    parseWorkflow(workflowText).jobs.check.steps.find(
      (step) => step.name === "Run check",
    )?.run,
  );
  expect(runTestFiles(script)).toEqual({ requested: true, suffixTwin: false });
  // Without the ./ prefix bun treats the path as a filter and runs both.
  const unprefixed = script.replace(
    `"\${test_files[@]/#/./}"`,
    `"\${test_files[@]}"`,
  );
  expect(unprefixed).not.toBe(script);
  expect(runTestFiles(unprefixed)).toEqual({
    requested: true,
    suffixTwin: true,
  });
});

test("every result step runs whenever input validation ran", () => {
  const steps = parseWorkflow(workflowText).jobs.check.steps;
  for (const name of ["Write result", "Upload result", "Set conclusion"]) {
    expect(steps.find((step) => step.name === name)?.if, name).toBe(
      "always() && steps.validate.outcome != 'skipped'",
    );
  }
});

const fixtureRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "manual-check-input-"));
  mkdirSync(path.join(root, "apps", "fixture", "src"), { recursive: true });
  mkdirSync(path.join(root, "packages"), { recursive: true });
  writeFileSync(
    path.join(root, "apps", "fixture", "package.json"),
    JSON.stringify({ name: "@stll/fixture" }),
  );
  writeFileSync(path.join(root, "apps", "fixture", "src", "one.test.ts"), "");
  writeFileSync(path.join(root, "apps", "fixture", "src", "two.test.tsx"), "");
  return root;
};

test("valid package and test-list targets are accepted", () => {
  const root = fixtureRoot();
  assertProperty(
    "valid package and test-list targets are accepted",
    fc.property(
      fc.subarray(
        ["apps/fixture/src/one.test.ts", "apps/fixture/src/two.test.tsx"],
        { minLength: 1 },
      ),
      (files) => {
        expect(
          validateManualCheckInput("typecheck-package", "@stll/fixture", root),
        ).toEqual([]);
        expect(
          validateManualCheckInput("test-files", files.join(" "), root),
        ).toEqual([]);
      },
    ),
  );
});

test("missing, non-test, excessive, or inapplicable targets are rejected", () => {
  const root = fixtureRoot();
  assertProperty(
    "missing, non-test, excessive, or inapplicable targets are rejected",
    fc.property(
      fc.integer({ min: 51, max: 75 }),
      fc.stringMatching(/^[a-z]{1,12}$/u),
      (fileCount, packageSuffix) => {
        for (const target of [
          "apps/fixture/src/missing.test.ts",
          "apps/fixture/src/one.spec.js",
          "apps/fixture/src/one.ts",
        ]) {
          expect(
            validateManualCheckInput("test-files", target, root),
          ).not.toEqual([]);
        }
        expect(
          validateManualCheckInput(
            "typecheck-package",
            `@stll/missing-${packageSuffix}`,
            root,
          ),
        ).not.toEqual([]);
        expect(
          validateManualCheckInput(
            "test-files",
            Array.from(
              { length: fileCount },
              () => "apps/fixture/src/one.test.ts",
            ).join(" "),
            root,
          ),
        ).not.toEqual([]);
        for (const check of ["typecheck-repo", "lint", "verify-affected"]) {
          expect(
            validateManualCheckInput(check, "unexpected", root),
          ).not.toEqual([]);
        }
      },
    ),
  );
});

test("test lists separated by anything but spaces are rejected", () => {
  const root = fixtureRoot();
  assertProperty(
    "test lists separated by anything but spaces are rejected",
    fc.property(fc.constantFrom("\n", "\r\n", "\t", " \n "), (separator) => {
      expect(
        validateManualCheckInput(
          "test-files",
          [
            "apps/fixture/src/one.test.ts",
            "apps/fixture/src/two.test.tsx",
          ].join(separator),
          root,
        ),
      ).not.toEqual([]);
    }),
  );
});
