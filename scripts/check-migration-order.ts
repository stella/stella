#!/usr/bin/env bun

import { panic } from "better-result";
import path from "node:path";

type MigrationOrderViolation =
  | { type: "invalid-name"; directory: string }
  | {
      type: "not-after-base";
      directory: string;
      timestamp: string;
      previousTimestamp: string;
    };

const MIGRATION_TIMESTAMP = /(?:^|\/)([0-9]{14})_[^/]+$/u;
const REPO_ROOT = path.resolve(import.meta.dir, "..");

const timestampFromDirectory = (directory: string): string | null =>
  MIGRATION_TIMESTAMP.exec(directory)?.at(1) ?? null;

export const findMigrationOrderViolation = ({
  baseDirectories,
  newDirectories,
}: {
  baseDirectories: readonly string[];
  newDirectories: readonly string[];
}): MigrationOrderViolation | null => {
  const latestBaseTimestamp = baseDirectories
    .map(timestampFromDirectory)
    .filter((timestamp) => timestamp !== null)
    .toSorted()
    .at(-1);
  let previousTimestamp = latestBaseTimestamp ?? "";

  for (const directory of newDirectories.toSorted()) {
    const timestamp = timestampFromDirectory(directory);
    if (timestamp === null) {
      return { type: "invalid-name", directory };
    }
    if (timestamp <= previousTimestamp) {
      return {
        type: "not-after-base",
        directory,
        timestamp,
        previousTimestamp,
      };
    }
    previousTimestamp = timestamp;
  }

  return null;
};

const runGit = (arguments_: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `git ${arguments_.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

if (import.meta.main) {
  const baseRef = Bun.argv.at(2);
  if (baseRef === undefined) {
    panic("Usage: bun scripts/check-migration-order.ts <base-ref>");
  }

  const baseDirectories = runGit([
    "ls-tree",
    "-d",
    "--name-only",
    `${baseRef}:apps/api/drizzle`,
  ])
    .split("\n")
    .filter(Boolean);
  const newDirectories = runGit([
    "diff",
    "--diff-filter=A",
    "--name-only",
    `${baseRef}...HEAD`,
    "--",
    "apps/api/drizzle",
  ])
    .split("\n")
    .filter((file) => file.endsWith("/migration.sql"))
    .map((file) => path.posix.dirname(file));
  const violation = findMigrationOrderViolation({
    baseDirectories,
    newDirectories,
  });

  if (violation?.type === "invalid-name") {
    panic(
      `New migration directory must start with a 14-digit timestamp: ${violation.directory}`,
    );
  }
  if (violation?.type === "not-after-base") {
    panic(
      `New migration ${violation.directory} has timestamp ${violation.timestamp}, ` +
        `which is not above ${violation.previousTimestamp}. Rename the directory ` +
        `(and its journal entry) to a timestamp above ${violation.previousTimestamp}: ` +
        `a database that already recorded ${violation.previousTimestamp} skips this ` +
        `migration silently, so its DDL never runs and nothing reports an error.`,
    );
  }
}
