import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sharedTestDatabase,
  sharedTestMigrationHistory,
  snapshotSharedTestMigrations,
} from "./shared-test-postgres";

test("worktree identities are bounded SQL identifiers and distinguish paths", () => {
  const paths = [
    "/work/a",
    "/work/b",
    "/work/á",
    "/work/a b",
    '/work/team\'s notes; "draft"',
  ];
  const databases = paths.map(sharedTestDatabase);
  expect(new Set(databases).size).toBe(paths.length);
  for (const database of databases) {
    expect(database).toMatch(/^stella_test_[a-f0-9]{24}$/u);
    expect(database.length).toBeLessThan(63);
  }
  expect(sharedTestDatabase("/work/a")).toBe(sharedTestDatabase("/work/a"));
});

test("a rejected migration snapshot can be retried after an added migration is reverted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-pg-snapshot-"));
  try {
    const tree = path.join(root, "worker");
    const first = path.join(tree, "apps/api/drizzle/20260101000000_first");
    mkdirSync(first, { recursive: true });
    writeFileSync(path.join(first, "migration.sql"), "SELECT 1;");
    const history = sharedTestMigrationHistory(tree);
    const histories = path.join(root, "histories");
    const extra = path.join(tree, "apps/api/drizzle/20260102000000_extra");
    mkdirSync(extra);
    writeFileSync(path.join(extra, "migration.sql"), "SELECT 2;");
    expect(() => snapshotSharedTestMigrations(history, histories)).toThrow(
      "Worker migrations changed during snapshot",
    );
    expect(existsSync(path.join(histories, history.key))).toBe(false);
    expect(readdirSync(histories)).toEqual([]);
    rmSync(extra, { recursive: true });
    expect(sharedTestMigrationHistory(tree).key).toBe(history.key);
    const folder = snapshotSharedTestMigrations(history, histories);
    expect(readdirSync(folder)).toEqual(["20260101000000_first"]);
    expect(
      sharedTestMigrationHistory(path.join(histories, history.key)).key,
    ).toBe(history.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration history identity follows ordered migration names and SQL rather than worker paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-pg-history-"));
  const trees = [path.join(root, "a"), path.join(root, "b")] as const;
  const migrations = [
    ["20260101000000_first", "CREATE TABLE first_fixture (id integer);"],
    ["20260102000000_second", "CREATE TABLE second_fixture (id integer);"],
  ] as const;
  try {
    for (const [index, tree] of trees.entries()) {
      const ordered = index === 0 ? migrations : migrations.toReversed();
      for (const [name, sql] of ordered) {
        const folder = path.join(tree, "apps/api/drizzle", name);
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, "migration.sql"), sql);
      }
    }
    const [first, second] = trees;
    const baseline = sharedTestMigrationHistory(first);
    expect(baseline.folder).toBe(path.join(first, "apps/api/drizzle"));
    expect(sharedTestMigrationHistory(second).key).toBe(baseline.key);
    const changedSql = path.join(
      second,
      "apps/api/drizzle",
      migrations[1][0],
      "migration.sql",
    );
    writeFileSync(
      changedSql,
      `${migrations[1][1]}\n-- changed committed migration`,
    );
    expect(sharedTestMigrationHistory(second).key).not.toBe(baseline.key);
    writeFileSync(changedSql, migrations[1][1]);
    expect(sharedTestMigrationHistory(second).key).toBe(baseline.key);
    renameSync(
      path.dirname(changedSql),
      path.join(second, "apps/api/drizzle/20260103000000_renamed"),
    );
    expect(sharedTestMigrationHistory(second).key).not.toBe(baseline.key);
    const appended = path.join(
      first,
      "apps/api/drizzle/20260104000000_appended",
    );
    mkdirSync(appended);
    writeFileSync(
      path.join(appended, "migration.sql"),
      "CREATE TABLE appended_fixture (id integer);",
    );
    expect(sharedTestMigrationHistory(first).key).not.toBe(baseline.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
