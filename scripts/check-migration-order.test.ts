import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findMigrationIdentityViolation,
  readMigrationChanges,
} from "./check-migration-order";

const migrationDirectory = (name: string) => `apps/api/drizzle/${name}`;

describe("migration identity", () => {
  test("accepts a migration stamped before one already on the base branch", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [migrationDirectory("20260801110000_late_arrival")],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("accepts two new migrations with the same timestamp", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [
          migrationDirectory("20260801140000_first"),
          migrationDirectory("20260801140000_second"),
        ],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("rejects a directory without the timestamp prefix", () => {
    const directory = migrationDirectory("report_export_result_field");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [directory],
        removedDirectories: [],
      }),
    ).toEqual({ type: "invalid-name", directory });
  });

  test("rejects deleting a base migration", () => {
    const directory = migrationDirectory("20260801120000_existing");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [],
        removedDirectories: [directory],
      }),
    ).toEqual({ type: "removed-base-migration", directory });
  });

  test("rejects renaming a base migration", () => {
    const directory = migrationDirectory("20260801120000_existing");
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [migrationDirectory("20260801130000_renamed")],
        removedDirectories: [directory],
      }),
    ).toEqual({ type: "removed-base-migration", directory });
  });

  test("accepts a pull request without migration changes", () => {
    expect(
      findMigrationIdentityViolation({
        addedDirectories: [],
        removedDirectories: [],
      }),
    ).toBeNull();
  });

  test("a folder rename appears as a deletion and an addition in git", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "migration-identity-"));
    const runGit = (...arguments_: string[]) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    try {
      runGit("init", "-b", "main");
      runGit("config", "user.name", "Test User");
      runGit("config", "user.email", "test@example.com");
      runGit("config", "commit.gpgsign", "false");
      const original = migrationDirectory("20260801120000_original");
      const renamed = migrationDirectory("20260801130000_renamed");
      mkdirSync(path.join(cwd, original), { recursive: true });
      writeFileSync(path.join(cwd, original, "migration.sql"), "SELECT 1;\n");
      runGit("add", ".");
      runGit("commit", "-m", "Initial migration");
      runGit("switch", "-c", "feature");
      renameSync(path.join(cwd, original), path.join(cwd, renamed));
      runGit("add", "-A");
      runGit("commit", "-m", "Rename migration");

      expect(
        runGit(
          "-c",
          "diff.renames=true",
          "diff",
          "--name-status",
          "main...HEAD",
        ),
      ).toContain("R100");
      expect(readMigrationChanges({ baseRef: "main", cwd })).toEqual({
        addedDirectories: [renamed],
        removedDirectories: [original],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
