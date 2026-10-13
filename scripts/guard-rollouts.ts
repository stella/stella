import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  isPathInside,
  repoRelativePath,
} from "../packages/portable-path/src/index";

export type GuardRollout = {
  id: string;
  check: readonly string[];
  rules?: readonly string[];
} & (
  | { type: "changed-lines"; expiresAt: string }
  | { type: "full" }
  | { type: "autofix"; generator: string }
);

export const GUARD_ROLLOUTS: readonly GuardRollout[] = [
  {
    id: "portable-path",
    rules: ["no-raw-path-relative/no-raw-path-relative"],
    type: "changed-lines",
    expiresAt: "2026-10-20T00:00:00.000Z",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-raw-path-relative/no-raw-path-relative",
      ".",
    ],
  },
  {
    id: "central-test-timeout",
    type: "changed-lines",
    expiresAt: "2026-10-20T00:00:00.000Z",
    check: ["bun", "scripts/check-oxlint-test-timeouts.ts"],
  },
] as const;

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
  }).trim();
  const tracked = execFileSync("git", ["ls-files", "--", file], {
    cwd: ROOT,
    encoding: "utf-8",
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
    },
  );
  const lines = changedLineNumbers(diff);
  lineCache.set(file, lines);
  return lines;
};

type GuardLineOptions = {
  guard: string;
  file: string;
  line: number;
  now?: Date;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
};

export const guardEnforcesLine = ({
  guard,
  file,
  line,
  now = new Date(),
  changedLines,
}: GuardLineOptions): boolean => {
  const rollout = GUARD_ROLLOUTS.find(({ id }) => id === guard);
  if (rollout === undefined) {
    return panic(`Unregistered guard rollout: ${guard}`);
  }
  if (
    rollout.type !== "changed-lines" ||
    process.env.STELLA_GUARD_SCOPE === "all"
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
