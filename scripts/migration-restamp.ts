#!/usr/bin/env bun

import { panic } from "better-result";
import { Glob } from "bun";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  findMigrationTimestampViolations,
  MIGRATION_TIMESTAMP,
  readMigrationBaseSnapshot,
} from "./migration-stamps";
import { PR_GENERATORS } from "./pr-regeneration";

export {
  findMigrationTimestampViolations,
  readMigrationBaseSnapshot,
  readMigrationChanges,
} from "./migration-stamps";

export class StaleMigrationStampError extends Error {
  override name = "StaleMigrationStampError";
  readonly _tag = "StaleMigrationStampError";
}

export class MigrationRestampScopeError extends Error {
  override name = "MigrationRestampScopeError";
  readonly _tag = "MigrationRestampScopeError";
}

export class MigrationRestampBinaryReferenceError extends Error {
  override name = "MigrationRestampBinaryReferenceError";
  readonly _tag = "MigrationRestampBinaryReferenceError";
}

const WRITABLE_OUTPUTS = PR_GENERATORS["migration-restamp"].outputs.map(
  (pattern) => new Glob(pattern),
);

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const stampToDate = (stamp: string) =>
  new Date(
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
    ),
  );

const dateToStamp = (date: Date) =>
  date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);

const migrationNamePattern = (name: string) =>
  new RegExp(
    `(?<![\\w_-])${name.replaceAll(
      /[.*+?^${}()|[\]\\]/gu,
      (character) => `\\${character}`,
    )}(?![\\w_-])`,
    "gu",
  );

const trackedReferenceFiles = (cwd: string, name: string) => {
  // Untracked migrations are part of the change set, so their files are
  // searched too (still excluding ignored paths).
  const result = Bun.spawnSync(
    ["git", "grep", "--untracked", "-l", "-z", "-F", "--", name],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`git grep failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((file) => {
      const contents = readFileSync(path.join(cwd, file));
      if (contents.includes(0)) {
        if (migrationNamePattern(name).test(contents.toString("latin1"))) {
          throw new MigrationRestampBinaryReferenceError(
            `Binary generator output carries migration name ${name}: ${file}`,
          );
        }
        return false;
      }
      return migrationNamePattern(name).test(contents.toString("utf-8"));
    });
};

export const verifyRestampedMigrations = ({
  baseRef,
  cwd,
  expectedAddedDirectories,
}: {
  baseRef: string;
  cwd: string;
  expectedAddedDirectories: readonly string[];
}) => {
  const snapshot = readMigrationBaseSnapshot({ baseRef, cwd });
  const actual = snapshot.changes.addedDirectories.toSorted();
  const expected = expectedAddedDirectories.toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((file, index) => file !== expected[index])
  ) {
    throw new StaleMigrationStampError(
      `re-stamp wrote unexpected migration directories: expected ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  }
  const stale = findMigrationTimestampViolations({
    addedDirectories: actual,
    baseDirectories: snapshot.baseDirectories,
  });
  if (stale.length > 0) {
    throw new StaleMigrationStampError(
      stale
        .map(
          ({ directory, newestBaseDirectory }) =>
            `stale migration stamp: ${directory} must follow ${newestBaseDirectory}`,
        )
        .join("\n"),
    );
  }
};

export const restampMigrations = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}) => {
  const snapshot = readMigrationBaseSnapshot({ baseRef, cwd });
  const stale = findMigrationTimestampViolations({
    addedDirectories: snapshot.changes.addedDirectories,
    baseDirectories: snapshot.baseDirectories,
  }).toSorted((left, right) => {
    if (left.directory < right.directory) {
      return -1;
    }
    if (left.directory > right.directory) {
      return 1;
    }
    return 0;
  });
  if (stale.length === 0) {
    return [];
  }
  const firstStale = stale.at(0);
  if (firstStale === undefined) {
    panic("Missing stale migration");
  }
  const baseStamp = MIGRATION_TIMESTAMP.exec(
    firstStale.newestBaseDirectory,
  )?.at(1);
  if (baseStamp === undefined) {
    panic("Newest base migration has no timestamp");
  }
  // Plan over every migration the branch adds, in its own order: each keeps
  // its stamp when that is still at least a minute after the previous one,
  // and moves just past it otherwise, so a re-stamp never reorders the set.
  const added = snapshot.changes.addedDirectories
    .filter((directory) =>
      MIGRATION_TIMESTAMP.test(path.posix.basename(directory)),
    )
    .toSorted((left, right) => {
      const leftName = path.posix.basename(left);
      const rightName = path.posix.basename(right);
      if (leftName < rightName) {
        return -1;
      }
      return leftName > rightName ? 1 : 0;
    });
  let earliest = stampToDate(baseStamp).getTime() + 60_000;
  const moves = added.flatMap((directory) => {
    const stamp = MIGRATION_TIMESTAMP.exec(path.posix.basename(directory))?.at(
      1,
    );
    if (stamp === undefined) {
      panic(`Added migration ${directory} has no timestamp`);
    }
    const own = stampToDate(stamp).getTime();
    const target = Math.max(own, earliest);
    earliest = target + 60_000;
    return target === own ? [] : [{ directory, target: new Date(target) }];
  });
  const plan = moves.map(({ directory, target }) => {
    const oldName = path.posix.basename(directory);
    return {
      directory,
      oldName,
      newName: `${dateToStamp(target)}_${oldName.slice(15)}`,
      movedDirectory: `${path.posix.dirname(directory)}/${dateToStamp(target)}_${oldName.slice(15)}`,
      sql: readFileSync(path.join(cwd, directory, "migration.sql")),
    };
  });
  // References are found while every path is still tracked; migration SQL
  // is never rewritten, so its bytes stay identical.
  const referenceFiles = [
    ...new Set(
      plan.flatMap(({ oldName }) => trackedReferenceFiles(cwd, oldName)),
    ),
  ].filter((file) => path.posix.basename(file) !== "migration.sql");
  const outside = referenceFiles.filter(
    (file) => !WRITABLE_OUTPUTS.some((pattern) => pattern.match(file)),
  );
  if (outside.length > 0) {
    throw new MigrationRestampScopeError(
      `Migration references outside the re-stamp outputs; re-stamp by hand: ${outside.join(", ")}`,
    );
  }
  // Stamps only move forward, and a target equal to a later migration's
  // current name means that migration moves too; renaming from the last move
  // vacates every destination first.
  for (const { directory, movedDirectory } of plan.toReversed()) {
    renameSync(path.join(cwd, directory), path.join(cwd, movedDirectory));
  }
  const movedPath = (file: string) => {
    const owner = plan.find(({ directory }) =>
      file.startsWith(`${directory}/`),
    );
    return owner === undefined
      ? file
      : `${owner.movedDirectory}${file.slice(owner.directory.length)}`;
  };
  // One pass replaces every old name at once, so a new name that equals
  // another migration's old name is never rewritten twice.
  const renames = new Map(
    plan.map(({ oldName, newName }) => [oldName, newName]),
  );
  const oldNames = new RegExp(
    [...renames.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map((name) =>
        name.replaceAll(
          /[.*+?^${}()|[\]\\]/gu,
          (character) => `\\${character}`,
        ),
      )
      .join("|"),
    "gu",
  );
  for (const file of referenceFiles) {
    const filePath = path.join(cwd, movedPath(file));
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf-8").replaceAll(
        new RegExp(`(?<![\\w_-])(?:${oldNames.source})(?![\\w_-])`, "gu"),
        (name) =>
          renames.get(name) ?? panic(`Unplanned migration name ${name}`),
      ),
    );
  }
  for (const { oldName, movedDirectory, sql } of plan) {
    const movedSql = readFileSync(
      path.join(cwd, movedDirectory, "migration.sql"),
    );
    if (!sql.equals(movedSql)) {
      panic(`Migration SQL changed while re-stamping ${oldName}`);
    }
  }
  const movedByDirectory = new Map(
    plan.map(({ directory, movedDirectory }) => [directory, movedDirectory]),
  );
  verifyRestampedMigrations({
    baseRef,
    cwd,
    expectedAddedDirectories: snapshot.changes.addedDirectories.map(
      (directory) => movedByDirectory.get(directory) ?? directory,
    ),
  });
  return plan.map(({ oldName, newName }) => ({ oldName, newName }));
};

export const checkMigrationStamps = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}) => {
  const snapshot = readMigrationBaseSnapshot({ baseRef, cwd });
  const stale = findMigrationTimestampViolations({
    addedDirectories: snapshot.changes.addedDirectories,
    baseDirectories: snapshot.baseDirectories,
  });
  if (stale.length > 0) {
    throw new StaleMigrationStampError(
      stale
        .map(
          ({ directory, newestBaseDirectory }) =>
            `stale migration stamp: ${directory} must follow ${newestBaseDirectory}`,
        )
        .join("\n"),
    );
  }
};

const usage =
  "Usage: bun scripts/migration-restamp.ts (--check|--write) --base <ref>";

if (import.meta.main) {
  const mode = Bun.argv.at(2);
  const baseFlag = Bun.argv.at(3);
  const baseRef = Bun.argv.at(4);
  if (
    (mode !== "--check" && mode !== "--write") ||
    baseFlag !== "--base" ||
    baseRef === undefined
  ) {
    panic(usage);
  }
  if (mode === "--write") {
    restampMigrations({ baseRef, cwd: REPO_ROOT });
  }
  try {
    checkMigrationStamps({ baseRef, cwd: REPO_ROOT });
  } catch (error) {
    if (!(error instanceof StaleMigrationStampError)) {
      throw error;
    }
    console.error(error.message);
    process.exit(1);
  }
}
