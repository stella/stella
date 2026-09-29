#!/usr/bin/env bun

import { panic } from "better-result";
import path from "node:path";

type MigrationIdentityViolation =
  | { type: "invalid-name"; directory: string }
  | { type: "removed-base-migration"; directory: string };

type MigrationChanges = {
  addedDirectories: readonly string[];
  removedDirectories: readonly string[];
};

const MIGRATION_TIMESTAMP = /(?:^|\/)([0-9]{14})_[^/]+$/u;
const MIGRATION_FILE = /^apps\/api\/drizzle\/[^/]+\/migration\.sql$/u;
const REPO_ROOT = path.resolve(import.meta.dir, "..");

export const findMigrationIdentityViolation = ({
  addedDirectories,
  removedDirectories,
}: MigrationChanges): MigrationIdentityViolation | null => {
  const directory = removedDirectories.at(0);
  if (directory !== undefined) {
    return { type: "removed-base-migration", directory };
  }
  for (const addedDirectory of addedDirectories) {
    if (!MIGRATION_TIMESTAMP.test(addedDirectory)) {
      return { type: "invalid-name", directory: addedDirectory };
    }
  }
  return null;
};

export const readMigrationChanges = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): MigrationChanges => {
  const arguments_ = [
    "diff",
    "--no-renames",
    "--name-status",
    `${baseRef}...HEAD`,
    "--",
    "apps/api/drizzle",
  ];
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `git ${arguments_.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }

  const addedDirectories: string[] = [];
  const removedDirectories: string[] = [];
  for (const line of result.stdout.toString().split("\n")) {
    const [status, filename] = line.split("\t");
    if (filename === undefined || !MIGRATION_FILE.test(filename)) {
      continue;
    }
    const directory = path.posix.dirname(filename);
    if (status === "A") {
      addedDirectories.push(directory);
    } else if (status === "D") {
      removedDirectories.push(directory);
    }
  }
  return { addedDirectories, removedDirectories };
};

if (import.meta.main) {
  const baseRef = Bun.argv.at(2);
  if (baseRef === undefined) {
    panic("Usage: bun scripts/check-migration-order.ts <base-ref>");
  }

  const violation = findMigrationIdentityViolation(
    readMigrationChanges({ baseRef, cwd: REPO_ROOT }),
  );
  if (violation?.type === "invalid-name") {
    panic(
      `New migration directory must start with a 14-digit timestamp: ${violation.directory}`,
    );
  }
  if (violation?.type === "removed-base-migration") {
    panic(
      `Migration directory ${violation.directory} was removed. The folder name is ` +
        `the migration's identity in the deployed ledger. Renaming a merged ` +
        `migration makes deployed databases re-run it under the new name; deleting ` +
        `it removes it from fresh databases. Add a new migration instead.`,
    );
  }
}
