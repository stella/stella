/**
 * The staged paths the pre-commit hooks check: what this commit's author
 * wrote. lefthook.yml feeds them (`files:`) to every hook that acts on staged
 * paths, so no hook computes its own list.
 *
 * - An ordinary commit: every added, copied, modified or renamed staged path,
 *   the set lefthook passes as `{staged_files}`.
 * - A merge commit (`MERGE_HEAD` exists): only the staged paths whose blob
 *   differs from HEAD and from every merged parent, which are the conflict
 *   resolutions and the edits made during the merge. A path taken unchanged
 *   from either side was checked when that side was committed; checking it
 *   again lints and reformats the other branch's files.
 *
 * Hooks that inspect the whole index by design (secrets, tracked symlinks,
 * lockfiles) do not use this list and never narrow.
 *
 * Git hands paths over NUL-terminated. lefthook reads one path per line, so a
 * path holding a newline cannot reach a hook intact: the script refuses
 * instead of passing a wrong list. `-z` prints NUL-terminated paths.
 *
 * Run: `bun scripts/precommit-paths.ts [-z]`
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const fail = (message: string): never => {
  console.error(`precommit-paths: ${message}`);
  process.exit(1);
};

const git = (cwd: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
};

/** Staged paths that differ from `parent`, or from HEAD when it is omitted. */
const stagedPathsChangedFrom = (cwd: string, parent?: string): string[] =>
  git(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--diff-filter=ACMR",
    ...(parent === undefined ? [] : [parent]),
    "--",
  ])
    .split("\0")
    .filter((file) => file !== "");

/** The commits an in-progress merge merges into HEAD; none outside a merge. */
export const mergeParents = (cwd: string): string[] => {
  const file = path.resolve(
    cwd,
    git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim(),
  );
  if (!existsSync(file)) {
    return [];
  }
  const heads = readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (heads.length === 0) {
    fail(
      "MERGE_HEAD names no commit. Finish the merge state with `git merge --abort` or `git merge --continue`, then commit again.",
    );
  }
  return heads.map((head) =>
    git(cwd, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]).trim(),
  );
};

/**
 * Staged paths whose blob differs from every commit in `parents`. With no
 * parents, every staged path changed from HEAD (an ordinary commit).
 */
export const stagedPathsChangedFromEvery = (
  cwd: string,
  parents: readonly string[],
): string[] => {
  const [first, ...rest] = parents;
  if (first === undefined) {
    return stagedPathsChangedFrom(cwd);
  }
  let paths = stagedPathsChangedFrom(cwd, first);
  for (const parent of rest) {
    const changed = new Set(stagedPathsChangedFrom(cwd, parent));
    paths = paths.filter((file) => changed.has(file));
  }
  return paths;
};

/** The staged paths this commit's author wrote (see the file comment). */
export const authorWrittenPaths = (cwd: string): string[] => {
  const merged = mergeParents(cwd);
  return stagedPathsChangedFromEvery(
    cwd,
    merged.length === 0 ? [] : ["HEAD", ...merged],
  );
};

if (import.meta.main) {
  const nul = Bun.argv.includes("-z");
  const paths = authorWrittenPaths(process.cwd());
  const unsafe = nul ? [] : paths.filter((file) => file.includes("\n"));
  if (unsafe.length > 0) {
    fail(
      `${unsafe.length} staged path(s) contain a newline, which lefthook cannot pass to a hook intact: ${JSON.stringify(unsafe)}. Rename them, stage the renames and commit again.`,
    );
  }
  process.stdout.write(
    paths.map((file) => `${file}${nul ? "\0" : "\n"}`).join(""),
  );
}
