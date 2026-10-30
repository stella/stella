import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSha256 } from "@stll/sha256/node";

import { findMigrationIdentityViolation } from "./check-migration-order";
import {
  checkMigrationStamps,
  findMigrationTimestampViolations,
  readMigrationBaseSnapshot,
  restampMigrations,
} from "./migration-restamp";

const git = (cwd: string, ...arguments_: string[]) => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};

const migration = (root: string, name: string, sql = "select 1;\n") => {
  const directory = path.join(root, "apps/api/drizzle", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "migration.sql"), sql);
};

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "migration-restamp-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  mkdirSync(path.join(root, "apps/api/src/lib/db"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/api/src/lib/db/migration-alias-inventory.json"),
    "[]\n",
  );
  migration(root, "20260101000000_initial");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  git(root, "branch", "base");
  git(root, "checkout", "-qb", "feature");
  return root;
};

const advanceBase = (root: string, name = "20260101020000_base_newer") => {
  git(root, "checkout", "-q", "base");
  migration(root, name, "select 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base migration");
  git(root, "checkout", "-q", "feature");
};

const commitFeature = (root: string) => {
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature migration");
};

const hash = (file: string) =>
  createSha256().update(readFileSync(file)).digest("hex");

test("reports and re-stamps a stale migration without changing SQL", () => {
  const root = fixture();
  try {
    const oldName = "20260101010000_feature";
    migration(root, oldName, "select 'unchanged';\n");
    writeFileSync(
      path.join(root, "references.json"),
      `${JSON.stringify({ introducedBy: oldName })}\n`,
    );
    commitFeature(root);
    advanceBase(root);
    const before = hash(
      path.join(root, "apps/api/drizzle", oldName, "migration.sql"),
    );
    const snapshot = readMigrationBaseSnapshot({ baseRef: "base", cwd: root });
    expect(
      findMigrationTimestampViolations({
        addedDirectories: snapshot.changes.addedDirectories,
        baseDirectories: snapshot.baseDirectories,
      }),
    ).toEqual([
      {
        type: "stale-timestamp",
        directory: `apps/api/drizzle/${oldName}`,
        newestBaseDirectory: "apps/api/drizzle/20260101020000_base_newer",
      },
    ]);
    expect(() => checkMigrationStamps({ baseRef: "base", cwd: root })).toThrow(
      "stale migration stamp: apps/api/drizzle/20260101010000_feature must follow apps/api/drizzle/20260101020000_base_newer",
    );
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName, newName: "20260101020100_feature" },
    ]);
    const newSql = path.join(
      root,
      "apps/api/drizzle/20260101020100_feature/migration.sql",
    );
    expect(hash(newSql)).toBe(before);
    expect(readFileSync(path.join(root, "references.json"), "utf-8")).toContain(
      "20260101020100_feature",
    );
    const after = readMigrationBaseSnapshot({ baseRef: "base", cwd: root });
    expect(
      findMigrationTimestampViolations({
        addedDirectories: after.changes.addedDirectories,
        baseDirectories: after.baseDirectories,
      }),
    ).toEqual([]);
    expect(() =>
      checkMigrationStamps({ baseRef: "base", cwd: root }),
    ).not.toThrow();
    expect(findMigrationIdentityViolation(after.changes)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps two added migrations in relative order", () => {
  const root = fixture();
  try {
    migration(root, "20260101003000_first");
    migration(root, "20260101010000_second");
    commitFeature(root);
    advanceBase(root);
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101003000_first", newName: "20260101020100_first" },
      { oldName: "20260101010000_second", newName: "20260101020200_second" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moves a later valid migration rather than reordering the branch", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    migration(root, "20260101020030_second");
    commitFeature(root);
    advanceBase(root);
    // first must follow the base at 02:00; second (02:00:30) is valid alone
    // but would then run before first, so it moves after it.
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_first", newName: "20260101020100_first" },
      { oldName: "20260101020030_second", newName: "20260101020200_second" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moves two migrations sharing a suffix when one targets the other's name", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_feature", "select 10;\n");
    migration(root, "20260101020100_feature", "select 11;\n");
    commitFeature(root);
    advanceBase(root);
    const firstSql = hash(
      path.join(root, "apps/api/drizzle/20260101010000_feature/migration.sql"),
    );
    const secondSql = hash(
      path.join(root, "apps/api/drizzle/20260101020100_feature/migration.sql"),
    );
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_feature", newName: "20260101020100_feature" },
      { oldName: "20260101020100_feature", newName: "20260101020200_feature" },
    ]);
    expect(
      hash(
        path.join(
          root,
          "apps/api/drizzle/20260101020100_feature/migration.sql",
        ),
      ),
    ).toBe(firstSql);
    expect(
      hash(
        path.join(
          root,
          "apps/api/drizzle/20260101020200_feature/migration.sql",
        ),
      ),
    ).toBe(secondSql);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps an added migration that already follows the moved ones", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    migration(root, "20260101030000_later");
    commitFeature(root);
    advanceBase(root);
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_first", newName: "20260101020100_first" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never touches a base migration and leaves newer branches unchanged", () => {
  const root = fixture();
  try {
    migration(root, "20260101030000_already_newer");
    commitFeature(root);
    advanceBase(root);
    const baseTree = git(root, "rev-parse", "base^{tree}");
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([]);
    expect(git(root, "rev-parse", "base^{tree}")).toBe(baseTree);
    expect(git(root, "status", "--short")).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
