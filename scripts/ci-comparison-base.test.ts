import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { changedFilesSince, comparisonBase } from "./ci-comparison-base";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

test("renames report the removed and added paths", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "comparison-base-"));
  const previous = process.cwd();
  try {
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "test@example.com");
    git(repository, "config", "user.name", "Test");
    writeFileSync(path.join(repository, "declared.txt"), "value\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "base");
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "mv", "declared.txt", "unrelated.txt");
    git(repository, "commit", "-qm", "rename");
    process.chdir(repository);
    expect(comparisonBase({ CI_COMPARISON_BASE: base })).toBe(base);
    expect(changedFilesSince(base)).toEqual(["declared.txt", "unrelated.txt"]);
  } finally {
    process.chdir(previous);
    rmSync(repository, { recursive: true, force: true });
  }
});

test("paths with non-ASCII characters, tabs and newlines come back exactly", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "comparison-base-"));
  const previous = process.cwd();
  // Git's line output would quote each of these names.
  const names = [
    "data/příliš žluťoučký.json",
    "data/tab\there.txt",
    "data/new\nline.txt",
  ];
  try {
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "test@example.com");
    git(repository, "config", "user.name", "Test");
    writeFileSync(path.join(repository, "base.txt"), "value\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "base");
    const base = git(repository, "rev-parse", "HEAD");
    mkdirSync(path.join(repository, "data"));
    for (const name of names) {
      writeFileSync(path.join(repository, name), "value\n");
    }
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "add");
    process.chdir(repository);
    expect(changedFilesSince(base).toSorted()).toEqual(names.toSorted());
  } finally {
    process.chdir(previous);
    rmSync(repository, { recursive: true, force: true });
  }
});

test("no CI or pull-request base requests a full run", () => {
  expect(comparisonBase({})).toBeUndefined();
});
