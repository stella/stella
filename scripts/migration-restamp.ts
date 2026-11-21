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

export class MigrationRestampUsageError extends Error {
  override name = "MigrationRestampUsageError";
  readonly _tag = "MigrationRestampUsageError";
}

export class MigrationRestampBinaryReferenceError extends Error {
  override name = "MigrationRestampBinaryReferenceError";
  readonly _tag = "MigrationRestampBinaryReferenceError";
}

/**
 * The files the CI regeneration may write. Autofix runs `--write` without
 * `--update-tests` and checks its changes against these outputs.
 */
const GENERATOR_OUTPUTS: readonly string[] =
  PR_GENERATORS["migration-restamp"].outputs;

/**
 * API test sources that name a migration (the PGlite schema list, migration
 * tests). A local re-stamp with `--update-tests` rewrites them as well; the CI
 * regeneration never does.
 */
export const TEST_REFERENCE_OUTPUTS: readonly string[] = [
  "apps/api/src/tests/**",
  "apps/api/src/**/*.test.ts",
];

const HOUR = 3_600_000;
const MINUTE = 60_000;

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

/**
 * Files named after a migration (a lock allowance is
 * `<migration name>.json`): the name lives in the path, not the contents, so
 * the reference search cannot see them and they move with the migration.
 */
const trackedNamedFiles = (cwd: string, name: string) => {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    panic(
      `git ls-files failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return [
    ...new Set(
      result.stdout
        .toString()
        .split("\0")
        .filter(Boolean)
        .filter((file) => {
          const base = path.posix.basename(file);
          return (
            base.slice(0, base.length - path.posix.extname(base).length) ===
            name
          );
        }),
    ),
  ];
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
  updateTests = false,
  forwardHours,
  now = new Date(),
}: {
  baseRef: string;
  cwd: string;
  /** Also rewrite API test sources that name a moved migration. */
  updateTests?: boolean;
  /**
   * Stamp every added migration at least this many whole hours after `now`
   * (and after the newest base migration), so later merges to the base do
   * not make it stale again before it lands.
   */
  forwardHours?: number;
  now?: Date;
}) => {
  if (
    forwardHours !== undefined &&
    (!Number.isSafeInteger(forwardHours) || forwardHours < 1)
  ) {
    throw new MigrationRestampUsageError(
      "forwardHours must be a positive whole number",
    );
  }
  const writableOutputs = [
    ...GENERATOR_OUTPUTS,
    ...(updateTests ? TEST_REFERENCE_OUTPUTS : []),
  ].map((pattern) => new Glob(pattern));
  const snapshot = readMigrationBaseSnapshot({ baseRef, cwd });
  const stale = findMigrationTimestampViolations({
    addedDirectories: snapshot.changes.addedDirectories,
    baseDirectories: snapshot.baseDirectories,
  });
  if (stale.length === 0 && forwardHours === undefined) {
    return [];
  }
  let baseStamp: string | undefined;
  for (const directory of snapshot.baseDirectories) {
    const stamp = MIGRATION_TIMESTAMP.exec(directory)?.at(1);
    if (stamp !== undefined && (baseStamp === undefined || stamp > baseStamp)) {
      baseStamp = stamp;
    }
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
  // The first added migration lands at least a minute after the newest base
  // one and, with --forward, at least that many hours ahead of now (in whole
  // minutes, like every other stamp).
  let earliest = Math.max(
    baseStamp === undefined
      ? Number.NEGATIVE_INFINITY
      : stampToDate(baseStamp).getTime() + MINUTE,
    forwardHours === undefined
      ? Number.NEGATIVE_INFINITY
      : Math.floor(now.getTime() / MINUTE) * MINUTE + forwardHours * HOUR,
  );
  const moves = added.flatMap((directory) => {
    const stamp = MIGRATION_TIMESTAMP.exec(path.posix.basename(directory))?.at(
      1,
    );
    if (stamp === undefined) {
      panic(`Added migration ${directory} has no timestamp`);
    }
    const own = stampToDate(stamp).getTime();
    const target = Math.max(own, earliest);
    earliest = target + MINUTE;
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
  const namedFiles = plan.flatMap(({ oldName, newName }) =>
    trackedNamedFiles(cwd, oldName).map((file) => ({
      file,
      movedFile: path.posix.join(
        path.posix.dirname(file),
        `${newName}${path.posix.extname(file)}`,
      ),
    })),
  );
  const outside = [
    ...referenceFiles,
    ...namedFiles.map(({ file }) => file),
  ].filter((file) => !writableOutputs.some((pattern) => pattern.match(file)));
  if (outside.length > 0) {
    const tests = updateTests
      ? []
      : outside.filter((file) =>
          TEST_REFERENCE_OUTPUTS.some((pattern) =>
            new Glob(pattern).match(file),
          ),
        );
    const hint =
      tests.length === outside.length
        ? "; re-run with --update-tests to rewrite these test references"
        : "; re-stamp by hand";
    throw new MigrationRestampScopeError(
      `Migration references outside the re-stamp outputs${hint}: ${outside.join(", ")}`,
    );
  }
  // Stamps only move forward, and a target equal to a later migration's
  // current name means that migration moves too; renaming from the last move
  // vacates every destination first.
  for (const { directory, movedDirectory } of plan.toReversed()) {
    renameSync(path.join(cwd, directory), path.join(cwd, movedDirectory));
  }
  for (const { file, movedFile } of namedFiles.toReversed()) {
    renameSync(path.join(cwd, file), path.join(cwd, movedFile));
  }
  const movedPath = (file: string) => {
    const named = namedFiles.find((entry) => entry.file === file);
    if (named !== undefined) {
      return named.movedFile;
    }
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
  "Usage: bun scripts/migration-restamp.ts (--check|--write) --base <ref> [--update-tests] [--forward <hours>]";

/**
 * `--update-tests` and `--forward` apply to `--write` only; the CI
 * regeneration passes neither.
 */
export const parseRestampArguments = (arguments_: readonly string[]) => {
  const [mode, baseFlag, baseRef, ...options] = arguments_;
  if (
    (mode !== "--check" && mode !== "--write") ||
    baseFlag !== "--base" ||
    baseRef === undefined ||
    baseRef.startsWith("--")
  ) {
    throw new MigrationRestampUsageError(usage);
  }
  let updateTests = false;
  let forwardHours: number | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--update-tests" && !updateTests) {
      updateTests = true;
    } else if (option === "--forward" && forwardHours === undefined) {
      const value = options[index + 1];
      if (value === undefined || !/^[1-9][0-9]{0,3}$/u.test(value)) {
        throw new MigrationRestampUsageError(
          `--forward takes a whole number of hours. ${usage}`,
        );
      }
      forwardHours = Number(value);
      index += 1;
    } else {
      throw new MigrationRestampUsageError(usage);
    }
  }
  if (mode === "--check" && (updateTests || forwardHours !== undefined)) {
    throw new MigrationRestampUsageError(
      `--update-tests and --forward apply to --write. ${usage}`,
    );
  }
  return { mode, baseRef, updateTests, forwardHours };
};

if (import.meta.main) {
  let parsed: ReturnType<typeof parseRestampArguments>;
  try {
    parsed = parseRestampArguments(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof MigrationRestampUsageError)) {
      throw error;
    }
    console.error(error.message);
    process.exit(2);
  }
  const { mode, baseRef, updateTests, forwardHours } = parsed;
  if (mode === "--write") {
    const moved = restampMigrations({
      baseRef,
      cwd: REPO_ROOT,
      updateTests,
      ...(forwardHours === undefined ? {} : { forwardHours }),
    });
    for (const { oldName, newName } of moved) {
      console.log(`${oldName} -> ${newName}`);
    }
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
