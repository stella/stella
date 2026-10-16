import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const root = path.resolve(import.meta.dir, "..");
const workflowRoot = path.join(root, ".github/workflows");
const allowedOwner = "the merge steward outside this repository";

const workflowFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return workflowFiles(file);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [file] : [];
  });

const normalizedWorkflow = (source: string): string =>
  source
    .replaceAll(/\\\r?\n/gu, " ")
    .replaceAll(/(?:^|\s)#.*$/gmu, " ")
    .replaceAll(/[\\"'`]/gu, "")
    .replaceAll(/\s+/gu, " ");

const hasDirectRerun = (source: string): boolean => {
  const text = normalizedWorkflow(source);
  return (
    /\bgh[\s,]+run[\s,]+rerun(?:-failed)?\b/u.test(text) ||
    /\/rerun(?:-failed-jobs)?\b/u.test(text) ||
    /\breRunWorkflow(?:FailedJobs)?\b/u.test(text)
  );
};

test("workflow reruns have one external owner", () => {
  const violations = workflowFiles(workflowRoot)
    .filter((file) => hasDirectRerun(readFileSync(file, "utf-8")))
    .map((file) => repoRelativePath(root, file));

  expect(violations, `Route reruns through ${allowedOwner}`).toEqual([]);
});

test("detects raw rerun commands across quoting and shell continuations", () => {
  for (const source of [
    "run: gh run rerun 123",
    `run: gh "run" \\
      "rerun" 123`,
    'run: python -c \'subprocess.run(["gh", "run", "rerun", "123"])\'',
    "run: curl -X POST https://api.github.com/repos/o/r/actions/runs/1/rerun-failed-jobs",
    "run: octokit.actions.reRunWorkflow({ run_id: 1 })",
  ]) {
    expect(hasDirectRerun(source)).toBe(true);
  }
});

test("ignores explanatory comments", () => {
  expect(
    hasDirectRerun("# gh run rerun 123 is handled by the owner\non: push"),
  ).toBe(false);
});
