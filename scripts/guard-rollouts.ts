import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  isPathInside,
  repoRelativePath,
} from "../packages/portable-path/src/index.ts";
import { GUARD_ROLLOUTS, type GuardRollout } from "./guard-rollout-policy.ts";

export const changedLineNumbers = (diff: string): ReadonlySet<number> => {
  const lines = new Set<number>();
  for (const match of diff.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu,
  )) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) {
      lines.add(line);
    }
  }
  return lines;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_ROOT = path.join(ROOT, ".oxlint-plugins", "__fixtures__");
const lineCache = new Map<string, ReadonlySet<number>>();
let mergeBase: string | undefined;
const gitMergeBase = (root: string) =>
  execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 2 ** 30,
  }).trim();
const changedLinesFor = (file: string): ReadonlySet<number> => {
  const cached = lineCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  mergeBase ??= gitMergeBase(ROOT);
  const tracked = execFileSync("git", ["ls-files", "--", file], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 2 ** 30,
  }).trim();
  // Untracked files (including isolated lint fixtures) are entirely new.
  if (tracked === "") {
    return new Set([Number.POSITIVE_INFINITY]);
  }
  const diff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--unified=0", mergeBase, "--", file],
    {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 2 ** 30,
    },
  );
  const lines = changedLineNumbers(diff);
  lineCache.set(file, lines);
  return lines;
};

type GuardLineOptions = {
  guard: string;
  rollouts?: readonly GuardRollout[];
  file: string;
  line: number;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
};

// A passing deadline does not widen the scope: that would fail changes that
// never touched the guarded line. scripts/dated-waivers.ts owns the deadline,
// and healing restores `type: "full"` once the full check passes.
/**
 * Changed lines of many tracked files from one diff against the merge base.
 * A caller that asks about thousands of files would otherwise start two Git
 * processes per file. Renames are not followed, so a moved file counts as
 * wholly added, as a diff of that path alone reports it.
 */
export const changedLinesForTrackedFiles = (
  files: readonly string[],
  root = ROOT,
): ReadonlyMap<string, ReadonlySet<number>> => {
  const base =
    root === ROOT ? (mergeBase ??= gitMergeBase(root)) : gitMergeBase(root);
  const diff = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--unified=0",
      base,
    ],
    { cwd: root, encoding: "utf-8", maxBuffer: 2 ** 30 },
  );
  const byFile = new Map<string, ReadonlySet<number>>();
  for (const section of diff.split(/^diff --git /mu).slice(1)) {
    const target = /^\+\+\+ b\/(.+?)\t?$/mu.exec(section)?.[1];
    if (target !== undefined) {
      byFile.set(target, changedLineNumbers(section));
    }
  }
  return new Map(
    files.map((file) => [file, byFile.get(file) ?? new Set<number>()]),
  );
};

export const guardEnforcesLine = ({
  guard,
  rollouts = GUARD_ROLLOUTS,
  file,
  line,
  changedLines,
}: GuardLineOptions): boolean => {
  const rollout = rollouts.find(({ id }) => id === guard);
  if (rollout === undefined) {
    return panic(`Unregistered guard rollout: ${guard}`);
  }
  if (
    rollout.type !== "changed-lines" ||
    process.env["STELLA_GUARD_SCOPE"] === "all"
  ) {
    return true;
  }
  // Expected-violation directives must remain used even in unchanged fixtures.
  if (isPathInside(FIXTURE_ROOT, path.resolve(ROOT, file))) {
    return true;
  }
  // Files outside the checkout have no merge-base history (isolated lint fixtures).
  if (
    changedLines === undefined &&
    !isPathInside(ROOT, path.resolve(ROOT, file))
  ) {
    return true;
  }
  const relative = path.isAbsolute(file) ? repoRelativePath(ROOT, file) : file;
  const lines =
    changedLines === undefined
      ? changedLinesFor(relative)
      : changedLines.get(relative);
  return (
    lines?.has(Number.POSITIVE_INFINITY) === true || lines?.has(line) === true
  );
};
