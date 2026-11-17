import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { unguardedRolesCreatedBy } from "./migration-roles";
import { sharedTestTemplateMigrations } from "./shared-test-template-migrations";

describe("shared template role replay", () => {
  test("guards historical role creation while retaining migration identity and hash", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "stella-role-replay-"));
    try {
      const migration = path.join(folder, "20260101000000_fixture");
      mkdirSync(migration);
      writeFileSync(
        path.join(migration, "migration.sql"),
        "-- CREATE ROLE fixture_reader NOLOGIN; describes the statement below\nCREATE ROLE fixture_reader NOLOGIN;--> statement-breakpoint\nCREATE TABLE public.fixture (id integer);",
      );
      const original = readMigrationFiles({ migrationsFolder: folder }).at(0);
      const replay = sharedTestTemplateMigrations({
        migrationsFolder: folder,
      }).at(0);
      expect(replay?.hash).toBe(original?.hash);
      expect(replay?.name).toBe(original?.name);
      expect(replay?.sql.at(0)).toContain("IF NOT EXISTS");
      expect(replay?.sql.at(0)).toContain(
        "rolcanlogin OR rolsuper OR rolbypassrls",
      );
      expect(replay?.sql.at(1)).toBe(original?.sql.at(1));
      expect(unguardedRolesCreatedBy(replay?.sql.at(0) ?? "missing")).toEqual(
        [],
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("refuses unsupported role privilege declarations", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "stella-role-replay-"));
    try {
      const migration = path.join(folder, "20260101000000_fixture");
      mkdirSync(migration);
      writeFileSync(
        path.join(migration, "migration.sql"),
        "CREATE ROLE fixture_reader NOLOGIN NOINHERIT;",
      );
      expect(() =>
        sharedTestTemplateMigrations({ migrationsFolder: folder }),
      ).toThrow("Unsupported shared template role creation");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
