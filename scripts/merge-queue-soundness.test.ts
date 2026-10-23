import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { changedFilesForCiPlan, selectsApiScope } from "./ci-plan-scope";

const ROOT = path.resolve(import.meta.dir, "..");
const RULESET_PATH = path.join(
  ROOT,
  ".github/branch-protection/ruleset-main.json",
);
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/ci.yml");
const MERGE_GROUP_BASE = "github.event.merge_group.base_sha";
const TARGET_BASE_OUTPUT = "steps.target-base.outputs.base_sha";
const QUEUE_BASE_EXPRESSION = `${String.fromCodePoint(36)}{{ github.event.merge_group.queue_base_sha }}`;

type WorkflowRecord = Record<string, unknown>;

const isWorkflowRecord = (value: unknown): value is WorkflowRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown, context: string): WorkflowRecord => {
  if (!isWorkflowRecord(value)) {
    throw new TypeError(`Expected ${context} to be a mapping`);
  }
  return value;
};

const readPair = () => {
  const ruleset = asRecord(
    JSON.parse(readFileSync(RULESET_PATH, "utf-8")),
    "ruleset",
  );
  const rules = ruleset["rules"];
  if (!Array.isArray(rules)) {
    throw new TypeError("Ruleset rules are missing");
  }
  const queueRule = rules
    .map((rule) => asRecord(rule, "ruleset rule"))
    .find((rule) => rule["type"] === "merge_queue");
  const parameters = asRecord(
    queueRule?.["parameters"],
    "merge queue parameters",
  );
  const groupingStrategy = parameters["grouping_strategy"];
  if (typeof groupingStrategy !== "string") {
    throw new TypeError("Merge queue grouping strategy is missing");
  }

  const workflow = asRecord(
    Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf-8")),
    "workflow",
  );
  const jobs = asRecord(workflow["jobs"], "workflow jobs");
  const ciPlan = asRecord(jobs["ci-plan"], "ci-plan job");
  const steps = ciPlan["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("ci-plan steps are missing");
  }
  const planner = steps
    .map((step) => asRecord(step, "ci-plan step"))
    .find((step) => step["id"] === "changed-files");
  const env = asRecord(planner?.["env"], "changed-files environment");
  const comparisonBase = env["BASE_SHA"];
  if (typeof comparisonBase !== "string") {
    throw new TypeError("Planner comparison base is missing");
  }
  return { groupingStrategy, comparisonBase };
};

// HEADGREEN checks only the group head, so a prefix entry could land without
// its own run whatever the comparison base; every entry needs ALLGREEN.
const assertSoundPair = (groupingStrategy: string, comparisonBase: string) => {
  if (groupingStrategy === "ALLGREEN") {
    return;
  }
  throw new TypeError(
    `Unsound merge queue pair: grouping_strategy=${groupingStrategy}, comparison_base=${comparisonBase}`,
  );
};

type Reader = { file: string; path: string };
const collectReaders = (
  value: unknown,
  file: string,
  currentPath: readonly string[],
  readers: Reader[],
) => {
  if (typeof value === "string") {
    if (value.includes(MERGE_GROUP_BASE)) {
      readers.push({ file, path: currentPath.join("/") });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectReaders(entry, file, [...currentPath, String(index)], readers);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectReaders(entry, file, [...currentPath, key], readers);
  }
};

const scanStep = (
  stepValue: unknown,
  file: string,
  job: string,
  readers: Reader[],
) => {
  const step = asRecord(stepValue, `${file} step`);
  const stepName = step["id"] ?? step["name"];
  if (typeof stepName !== "string") {
    throw new TypeError(`${file}/${job} has an unnamed step`);
  }
  for (const [key, value] of Object.entries(step)) {
    collectReaders(value, file, [job, stepName, key], readers);
  }
};

const mergeGroupBaseReaders = (): Reader[] => {
  const readers: Reader[] = [];
  const workflowFile = ".github/workflows/ci.yml";
  const workflow = asRecord(
    Bun.YAML.parse(readFileSync(path.join(ROOT, workflowFile), "utf-8")),
    "workflow",
  );
  const jobs = asRecord(workflow["jobs"], "workflow jobs");
  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue, `job ${jobId}`);
    for (const [key, value] of Object.entries(job)) {
      if (key !== "steps") {
        collectReaders(value, workflowFile, [jobId, key], readers);
      }
    }
    const steps = job["steps"];
    if (Array.isArray(steps)) {
      for (const step of steps) {
        scanStep(step, workflowFile, jobId, readers);
      }
    }
  }

  for (const file of new Bun.Glob(".github/ci-checks/*.yml").scanSync({
    cwd: ROOT,
  })) {
    const pool = asRecord(
      Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf-8")),
      file,
    );
    const checks = pool["checks"];
    if (!Array.isArray(checks)) {
      throw new TypeError(`${file} checks are missing`);
    }
    const job = path.basename(file, ".yml");
    for (const step of checks) {
      scanStep(step, file, job, readers);
    }
  }
  return readers;
};

const git = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI Soundness",
      GIT_AUTHOR_EMAIL: "ci-soundness@example.invalid",
      GIT_COMMITTER_NAME: "CI Soundness",
      GIT_COMMITTER_EMAIL: "ci-soundness@example.invalid",
    },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

test("merge queue grouping and the planner comparison base form a sound pair", () => {
  const pair = readPair();
  expect(pair.comparisonBase).toContain(TARGET_BASE_OUTPUT);
  expect(() =>
    assertSoundPair(pair.groupingStrategy, pair.comparisonBase),
  ).not.toThrow();
  expect(() => assertSoundPair("HEADGREEN", pair.comparisonBase)).toThrow(
    `grouping_strategy=HEADGREEN, comparison_base=${pair.comparisonBase}`,
  );
  expect(() => assertSoundPair("HEADGREEN", QUEUE_BASE_EXPRESSION)).toThrow(
    `grouping_strategy=HEADGREEN, comparison_base=${QUEUE_BASE_EXPRESSION}`,
  );
});

test("the patch id is the only direct merge-group base reader", () => {
  expect(mergeGroupBaseReaders()).toEqual([
    {
      file: ".github/workflows/ci.yml",
      path: "ci-plan/patch-id/env/GROUP_BASE_SHA",
    },
  ]);
});

test("a prefix merge needs the target-tip range to retain the API scope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-queue-soundness-"));
  try {
    git(root, "init", "--quiet", "--initial-branch=main");
    writeFileSync(path.join(root, "README.md"), "main\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "main");
    const main = git(root, "rev-parse", "HEAD");

    mkdirSync(path.join(root, "apps/api/src"), { recursive: true });
    writeFileSync(
      path.join(root, "apps/api/src/x.ts"),
      "export const x = 1;\n",
    );
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "entry E1");
    const entryOne = git(root, "rev-parse", "HEAD");

    mkdirSync(path.join(root, "apps/web/src"), { recursive: true });
    writeFileSync(
      path.join(root, "apps/web/src/y.ts"),
      "export const y = 1;\n",
    );
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "entry E2");
    const entryTwoGroup = git(root, "rev-parse", "HEAD");

    const targetTipFiles = changedFilesForCiPlan({
      root,
      base: main,
      head: entryTwoGroup,
    });
    const prefixFiles = changedFilesForCiPlan({
      root,
      base: entryOne,
      head: entryTwoGroup,
    });
    expect(targetTipFiles).toContain("apps/api/src/x.ts");
    expect(selectsApiScope(targetTipFiles)).toBe(true);
    expect(prefixFiles).not.toContain("apps/api/src/x.ts");
    expect(selectsApiScope(prefixFiles)).toBe(false);
    expect(() => assertSoundPair("HEADGREEN", QUEUE_BASE_EXPRESSION)).toThrow(
      /grouping_strategy=HEADGREEN.*comparison_base=/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
