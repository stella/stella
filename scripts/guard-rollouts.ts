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
const changedLinesFor = (file: string): ReadonlySet<number> => {
  const cached = lineCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  mergeBase ??= execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 2 ** 30,
  }).trim();
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
  now?: Date;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
};

export const guardEnforcesLine = ({
  guard,
  rollouts = GUARD_ROLLOUTS,
  file,
  line,
  now = new Date(),
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
  const deadline = Date.parse(rollout.expiresAt);
  if (!Number.isFinite(deadline)) {
    return panic(`Invalid guard rollout deadline: ${guard}`);
  }
  if (now.getTime() >= deadline) {
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
