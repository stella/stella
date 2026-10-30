#!/usr/bin/env bun

import { panic } from "better-result";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSha256 } from "@stll/sha256/bun";

export type MigrationIdentityChanges = {
  addedDirectories: readonly string[];
  removedDirectories: readonly string[];
};

export type MigrationChanges = MigrationIdentityChanges & {
  modifiedFiles: readonly string[];
};

export type StaleMigrationStamp = {
  type: "stale-timestamp";
  directory: string;
  newestBaseDirectory: string;
};

export class StaleMigrationStampError extends Error {
  override name = "StaleMigrationStampError";
  readonly _tag = "StaleMigrationStampError";
}

export const MIGRATION_TIMESTAMP = /(?:^|\/)([0-9]{14})_[^/]+$/u;
export const MIGRATION_FILE = /^apps\/api\/drizzle\/[^/]+\/migration\.sql$/u;
export const MIGRATION_FOLDER_FILE = /^apps\/api\/drizzle\/[^/]+\/.+$/u;
export const ALIAS_INVENTORY_PATH =
  "apps/api/src/lib/db/migration-alias-inventory.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

export const runGit = ({
  arguments_,
  cwd,
}: {
  arguments_: readonly string[];
  cwd: string;
}): Uint8Array => {
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
  return result.stdout;
};

export const readMigrationChanges = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): MigrationChanges => {
  const addedDirectories: string[] = [];
  const removedDirectories: string[] = [];
  const modifiedFiles: string[] = [];
  const output = new TextDecoder().decode(
    runGit({
      arguments_: [
        "diff",
        "--no-renames",
        "--name-status",
        baseRef,
        "--",
        "apps/api/drizzle",
      ],
      cwd,
    }),
  );
  for (const line of output.split("\n")) {
    const [status, filename] = line.split("\t");
    if (filename === undefined) {
      continue;
    }
    if (status !== "A" && status !== "D" && status !== "M") {
      panic(
        `Unsupported migration change status ${String(status)} for ${filename}`,
      );
    }
    if (status === "M" && MIGRATION_FOLDER_FILE.test(filename)) {
      modifiedFiles.push(filename);
      continue;
    }
    if (!MIGRATION_FILE.test(filename)) {
      continue;
    }
    const directory = path.posix.dirname(filename);
    if (status === "A") {
      addedDirectories.push(directory);
    } else if (status === "D") {
      removedDirectories.push(directory);
    }
  }
  return { addedDirectories, removedDirectories, modifiedFiles };
};

export const findMigrationTimestampViolations = ({
  addedDirectories,
  baseDirectories,
}: {
  addedDirectories: readonly string[];
  baseDirectories: readonly string[];
}): StaleMigrationStamp[] => {
  let newestBase: { directory: string; stamp: string } | undefined;
  for (const directory of baseDirectories) {
    const stamp = MIGRATION_TIMESTAMP.exec(directory)?.at(1);
    if (
      stamp !== undefined &&
      (newestBase === undefined || stamp > newestBase.stamp)
    ) {
      newestBase = { directory, stamp };
    }
  }
  if (newestBase === undefined) {
    return [];
  }
  return addedDirectories.flatMap((directory) => {
    const stamp = MIGRATION_TIMESTAMP.exec(directory)?.at(1);
    return stamp !== undefined && stamp <= newestBase.stamp
      ? [
          {
            type: "stale-timestamp" as const,
            directory,
            newestBaseDirectory: newestBase.directory,
          },
        ]
      : [];
  });
};

const readGitFile = ({
  ref,
  file,
  cwd,
}: {
  ref: string;
  file: string;
  cwd: string;
}) => runGit({ arguments_: ["show", `${ref}:${file}`], cwd });

const readBaseInventory = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): unknown => {
  const files = new TextDecoder()
    .decode(
      runGit({
        arguments_: [
          "ls-tree",
          "--name-only",
          baseRef,
          "--",
          ALIAS_INVENTORY_PATH,
        ],
        cwd,
      }),
    )
    .trim();
  if (files === "") {
    return [];
  }
  if (files !== ALIAS_INVENTORY_PATH) {
    panic(`Unexpected base inventory path: ${files}`);
  }
  return JSON.parse(
    new TextDecoder().decode(
      readGitFile({ ref: baseRef, file: ALIAS_INVENTORY_PATH, cwd }),
    ),
  );
};

export const readMigrationBaseSnapshot = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}) => {
  const mergeBase = new TextDecoder()
    .decode(runGit({ arguments_: ["merge-base", baseRef, "HEAD"], cwd }))
    .trim();
  const changes = readMigrationChanges({ baseRef: mergeBase, cwd });
  const baseInventory = readBaseInventory({ baseRef: mergeBase, cwd });
  const baseHashes = Object.fromEntries(
    changes.modifiedFiles
      .filter((candidate) => MIGRATION_FILE.test(candidate))
      .map((file) => [
        file,
        createSha256()
          .update(readGitFile({ ref: mergeBase, file, cwd }))
          .digest("hex"),
      ]),
  );
  const baseDirectories = new TextDecoder()
    .decode(
      runGit({
        arguments_: [
          "ls-tree",
          "--name-only",
          baseRef,
          "--",
          "apps/api/drizzle/",
        ],
        cwd,
      }),
    )
    .split("\n")
    .filter((directory) => MIGRATION_TIMESTAMP.test(directory));
  return { mergeBase, changes, baseInventory, baseHashes, baseDirectories };
};

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

const trackedReferenceFiles = (cwd: string, name: string) => {
  const result = Bun.spawnSync(["git", "grep", "-l", "-z", "-F", "--", name], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`git grep failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString().split("\0").filter(Boolean);
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
  // Stamps only move forward, and a target equal to a later migration's
  // current name means that migration moves too; applying the plan from the
  // last move vacates every destination (and rewrites its references) first.
  const applied = moves.toReversed().map(({ directory, target }) => {
    const oldName = path.posix.basename(directory);
    const suffix = oldName.slice(15);
    const newName = `${dateToStamp(target)}_${suffix}`;
    const sqlPath = path.join(cwd, directory, "migration.sql");
    const sqlBytes = readFileSync(sqlPath);
    const references = trackedReferenceFiles(cwd, oldName).filter(
      (file) => !file.startsWith(`${directory}/`),
    );
    renameSync(
      path.join(cwd, directory),
      path.join(cwd, path.posix.dirname(directory), newName),
    );
    for (const file of references) {
      const filePath = path.join(cwd, file);
      const contents = readFileSync(filePath, "utf-8");
      writeFileSync(
        filePath,
        contents.replaceAll(oldName, () => newName),
      );
    }
    const movedSql = readFileSync(
      path.join(cwd, path.posix.dirname(directory), newName, "migration.sql"),
    );
    if (!sqlBytes.equals(movedSql)) {
      panic(`Migration SQL changed while re-stamping ${oldName}`);
    }
    return { oldName, newName };
  });
  return applied.toReversed();
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
