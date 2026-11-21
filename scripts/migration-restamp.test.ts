import { expect, test } from "bun:test";
import {
  existsSync,
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
  MigrationRestampBinaryReferenceError,
  MigrationRestampScopeError,
  MigrationRestampUsageError,
  parseRestampArguments,
  readMigrationBaseSnapshot,
  restampMigrations,
  StaleMigrationStampError,
  verifyRestampedMigrations,
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
      path.join(root, "apps/api/src/lib/db/migration-alias-inventory.json"),
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
    expect(
      readFileSync(
        path.join(root, "apps/api/src/lib/db/migration-alias-inventory.json"),
        "utf-8",
      ),
    ).toContain("20260101020100_feature");
    const after = readMigrationBaseSnapshot({ baseRef: "base", cwd: root });
    expect(after.changes.addedDirectories).toEqual([
      "apps/api/drizzle/20260101020100_feature",
    ]);
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
    expect(
      readMigrationBaseSnapshot({ baseRef: "base", cwd: root }).changes
        .addedDirectories,
    ).toEqual([
      "apps/api/drizzle/20260101020100_first",
      "apps/api/drizzle/20260101020200_second",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-write verification rejects a planned stamp that remains stale", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_feature");
    commitFeature(root);
    advanceBase(root);
    expect(() =>
      verifyRestampedMigrations({
        baseRef: "base",
        cwd: root,
        expectedAddedDirectories: ["apps/api/drizzle/20260101010000_feature"],
      }),
    ).toThrow(StaleMigrationStampError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not match a migration name inside a longer name", () => {
  const root = fixture();
  try {
    const oldName = "20260101010000_first";
    migration(root, oldName);
    const inventory = path.join(
      root,
      "apps/api/src/lib/db/migration-alias-inventory.json",
    );
    writeFileSync(inventory, `${oldName}_backfill\n`);
    commitFeature(root);
    advanceBase(root);
    restampMigrations({ baseRef: "base", cwd: root });
    expect(readFileSync(inventory, "utf-8")).toBe(`${oldName}_backfill\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a binary output that carries a migration name", () => {
  const root = fixture();
  try {
    const oldName = "20260101010000_first";
    migration(root, oldName);
    writeFileSync(
      path.join(root, "apps/api/src/lib/db/migration-alias-inventory.json"),
      Buffer.from(`\0${oldName}\0`, "utf-8"),
    );
    commitFeature(root);
    advanceBase(root);
    expect(() => restampMigrations({ baseRef: "base", cwd: root })).toThrow(
      MigrationRestampBinaryReferenceError,
    );
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

const lockAllowance = (root: string, name: string, contents: string) => {
  const directory = path.join(root, "scripts/migration-lock-allowances");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), contents);
};

const readLockAllowance = (root: string, name: string) =>
  readFileSync(
    path.join(root, "scripts/migration-lock-allowances", `${name}.json`),
    "utf-8",
  );

const lockAllowanceExists = (root: string, name: string) =>
  existsSync(
    path.join(root, "scripts/migration-lock-allowances", `${name}.json`),
  );

test("moves a lock allowance named after a re-stamped migration", () => {
  const root = fixture();
  try {
    const allowance = `${JSON.stringify({ "add-foreign-key": "new table" })}\n`;
    migration(root, "20260101010000_feature");
    lockAllowance(root, "20260101010000_feature", allowance);
    commitFeature(root);
    advanceBase(root);
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_feature", newName: "20260101020100_feature" },
    ]);
    expect(lockAllowanceExists(root, "20260101010000_feature")).toBe(false);
    expect(readLockAllowance(root, "20260101020100_feature")).toBe(allowance);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moves lock allowances of two migrations when one targets the other's name", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_feature", "select 10;\n");
    migration(root, "20260101020100_feature", "select 11;\n");
    lockAllowance(root, "20260101010000_feature", '{"first":"a"}\n');
    lockAllowance(root, "20260101020100_feature", '{"second":"b"}\n');
    commitFeature(root);
    advanceBase(root);
    restampMigrations({ baseRef: "base", cwd: root });
    expect(lockAllowanceExists(root, "20260101010000_feature")).toBe(false);
    expect(readLockAllowance(root, "20260101020100_feature")).toBe(
      '{"first":"a"}\n',
    );
    expect(readLockAllowance(root, "20260101020200_feature")).toBe(
      '{"second":"b"}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses before renaming when a file named after the migration lies outside the generator outputs", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs/20260101010000_first.md"), "notes\n");
    commitFeature(root);
    advanceBase(root);
    expect(() => restampMigrations({ baseRef: "base", cwd: root })).toThrow(
      "docs/20260101010000_first.md",
    );
    expect(
      existsSync(
        path.join(root, "apps/api/drizzle/20260101010000_first/migration.sql"),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites a reference between two untracked migrations", () => {
  const root = fixture();
  try {
    advanceBase(root);
    migration(root, "20260101010000_first");
    migration(root, "20260101010100_second");
    writeFileSync(
      path.join(root, "apps/api/drizzle/20260101010100_second/requires.txt"),
      "requires: 20260101010000_first\n",
    );
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_first", newName: "20260101020100_first" },
      { oldName: "20260101010100_second", newName: "20260101020200_second" },
    ]);
    expect(
      readFileSync(
        path.join(root, "apps/api/drizzle/20260101020200_second/requires.txt"),
        "utf-8",
      ),
    ).toBe("requires: 20260101020100_first\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites a reference inside a moved migration to another moved one", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    migration(root, "20260101010100_second");
    writeFileSync(
      path.join(root, "apps/api/drizzle/20260101010100_second/requires.txt"),
      "requires: 20260101010000_first\n",
    );
    commitFeature(root);
    advanceBase(root);
    expect(restampMigrations({ baseRef: "base", cwd: root })).toEqual([
      { oldName: "20260101010000_first", newName: "20260101020100_first" },
      { oldName: "20260101010100_second", newName: "20260101020200_second" },
    ]);
    expect(
      readFileSync(
        path.join(root, "apps/api/drizzle/20260101020200_second/requires.txt"),
        "utf-8",
      ),
    ).toBe("requires: 20260101020100_first\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses before renaming when a reference lies outside the generator outputs", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(
      path.join(root, "docs/migrations.md"),
      "See 20260101010000_first.\n",
    );
    commitFeature(root);
    advanceBase(root);
    expect(() => restampMigrations({ baseRef: "base", cwd: root })).toThrow(
      "docs/migrations.md",
    );
    expect(
      readFileSync(
        path.join(root, "apps/api/drizzle/20260101010000_first/migration.sql"),
        "utf-8",
      ),
    ).toBe("select 1;\n");
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

const writeRepoFile = (root: string, file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const readRepoFile = (root: string, file: string) =>
  readFileSync(path.join(root, file), "utf-8");

test("refuses test references without --update-tests and names the flag", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_feature");
    writeRepoFile(
      root,
      "apps/api/src/tests/pglite-schema.ts",
      'export const names = ["20260101010000_feature"];\n',
    );
    commitFeature(root);
    advanceBase(root);
    expect(() => restampMigrations({ baseRef: "base", cwd: root })).toThrow(
      "re-run with --update-tests to rewrite these test references: apps/api/src/tests/pglite-schema.ts",
    );
    expect(
      existsSync(
        path.join(
          root,
          "apps/api/drizzle/20260101010000_feature/migration.sql",
        ),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-stamps a migration with its lock allowance and test references", () => {
  const root = fixture();
  try {
    const oldName = "20260101010000_feature";
    migration(root, oldName);
    lockAllowance(root, oldName, '{"create-trigger":"catalog only"}\n');
    writeRepoFile(
      root,
      "apps/api/src/tests/pglite-schema.ts",
      `export const names = [\n  "${oldName}",\n  "${oldName}_backfill",\n];\n`,
    );
    writeRepoFile(
      root,
      "apps/api/src/db/feature-migration.db.test.ts",
      `const file = "drizzle/${oldName}/migration.sql";\n`,
    );
    commitFeature(root);
    advanceBase(root);
    expect(
      restampMigrations({ baseRef: "base", cwd: root, updateTests: true }),
    ).toEqual([{ oldName, newName: "20260101020100_feature" }]);
    expect(lockAllowanceExists(root, oldName)).toBe(false);
    expect(readLockAllowance(root, "20260101020100_feature")).toBe(
      '{"create-trigger":"catalog only"}\n',
    );
    expect(readRepoFile(root, "apps/api/src/tests/pglite-schema.ts")).toBe(
      `export const names = [\n  "20260101020100_feature",\n  "${oldName}_backfill",\n];\n`,
    );
    expect(
      readRepoFile(root, "apps/api/src/db/feature-migration.db.test.ts"),
    ).toBe('const file = "drizzle/20260101020100_feature/migration.sql";\n');
    expect(() =>
      checkMigrationStamps({ baseRef: "base", cwd: root }),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--update-tests still refuses a non-test reference outside the outputs", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_feature");
    writeRepoFile(
      root,
      "apps/api/src/db/online-entry.ts",
      'export const migration = "20260101010000_feature";\n',
    );
    commitFeature(root);
    advanceBase(root);
    expect(() =>
      restampMigrations({ baseRef: "base", cwd: root, updateTests: true }),
    ).toThrow(MigrationRestampScopeError);
    expect(() =>
      restampMigrations({ baseRef: "base", cwd: root, updateTests: true }),
    ).toThrow("re-stamp by hand: apps/api/src/db/online-entry.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--forward stamps added migrations the given hours ahead of now", () => {
  const root = fixture();
  try {
    migration(root, "20260101010000_first");
    migration(root, "20260101010100_second");
    commitFeature(root);
    advanceBase(root);
    expect(
      restampMigrations({
        baseRef: "base",
        cwd: root,
        forwardHours: 6,
        now: new Date("2026-01-01T03:04:59.900Z"),
      }),
    ).toEqual([
      { oldName: "20260101010000_first", newName: "20260101090400_first" },
      { oldName: "20260101010100_second", newName: "20260101090500_second" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--forward moves a migration that is not stale yet", () => {
  const root = fixture();
  try {
    migration(root, "20260101030000_feature");
    commitFeature(root);
    advanceBase(root);
    expect(
      restampMigrations({
        baseRef: "base",
        cwd: root,
        forwardHours: 2,
        now: new Date("2026-01-01T02:30:00Z"),
      }),
    ).toEqual([
      { oldName: "20260101030000_feature", newName: "20260101043000_feature" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--forward keeps a stamp already past the target and follows a newer base", () => {
  const root = fixture();
  try {
    migration(root, "20260105000000_far");
    commitFeature(root);
    advanceBase(root);
    expect(
      restampMigrations({
        baseRef: "base",
        cwd: root,
        forwardHours: 1,
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const behind = fixture();
  try {
    migration(behind, "20260101010000_feature");
    commitFeature(behind);
    advanceBase(behind, "20260101120000_base_ahead");
    expect(
      restampMigrations({
        baseRef: "base",
        cwd: behind,
        forwardHours: 1,
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toEqual([
      { oldName: "20260101010000_feature", newName: "20260101120100_feature" },
    ]);
  } finally {
    rmSync(behind, { recursive: true, force: true });
  }
});

test("rejects a forward offset that is not a positive whole number of hours", () => {
  for (const forwardHours of [0, -1, 1.5, Number.NaN]) {
    expect(() =>
      restampMigrations({ baseRef: "base", cwd: tmpdir(), forwardHours }),
    ).toThrow(MigrationRestampUsageError);
  }
});

test("parses re-stamp arguments", () => {
  expect(parseRestampArguments(["--write", "--base", "origin/main"])).toEqual({
    mode: "--write",
    baseRef: "origin/main",
    updateTests: false,
    forwardHours: undefined,
  });
  expect(
    parseRestampArguments([
      "--write",
      "--base",
      "origin/main",
      "--forward",
      "12",
      "--update-tests",
    ]),
  ).toEqual({
    mode: "--write",
    baseRef: "origin/main",
    updateTests: true,
    forwardHours: 12,
  });
  for (const arguments_ of [
    [],
    ["--write"],
    ["--write", "--base"],
    ["--write", "--base", "--forward"],
    ["--write", "--base", "origin/main", "--forward"],
    ["--write", "--base", "origin/main", "--forward", "0"],
    ["--write", "--base", "origin/main", "--forward", "1.5"],
    ["--write", "--base", "origin/main", "--forward", "-2"],
    ["--write", "--base", "origin/main", "--forward", "2", "--forward", "3"],
    ["--write", "--base", "origin/main", "--update-tests", "--update-tests"],
    ["--write", "--base", "origin/main", "--unknown"],
    ["--check", "--base", "origin/main", "--update-tests"],
    ["--check", "--base", "origin/main", "--forward", "2"],
  ]) {
    expect(() => parseRestampArguments(arguments_)).toThrow(
      MigrationRestampUsageError,
    );
  }
});
