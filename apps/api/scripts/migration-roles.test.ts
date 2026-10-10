import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrationCreatedRoles,
  migrationRoleCreations,
  rolesCreatedBy,
  unguardedRolesCreatedBy,
} from "./migration-roles";

const DRIZZLE_DIR = path.resolve(import.meta.dir, "../drizzle");

/**
 * Migrations that create a role without checking for it first. They are
 * applied and cannot change; a new migration creates its role only when it is
 * missing (`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname =
 * '<role>') THEN CREATE ROLE <role> ...; END IF; END $$;`). This list only
 * shrinks.
 */
const UNGUARDED_ROLE_MIGRATIONS = new Set([
  "20260516000000_case_law_ingestion_role",
  "20260821150000_case_law_reader_role",
  "20260823190000_public_law_reader_role",
  "20260907180000_case_law_analysis_writer_role",
  "20260924153000_case_law_analysis_reader_role",
  "20260926120000_corpus_sample_reader_role",
  "20261003122400_public_sanctions_reader",
]);

const GUARDED = `SET lock_timeout = '1s';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture_reader') THEN
    CREATE ROLE fixture_reader NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fixture_reader;`;

const UNGUARDED = `-- CREATE ROLE commented_out NOLOGIN;
CREATE ROLE "fixture_writer" NOLOGIN;--> statement-breakpoint
/* CREATE ROLE block_commented NOLOGIN; */
GRANT USAGE ON SCHEMA public TO fixture_writer;`;

describe("roles the migrations create", () => {
  test("reads each created role from migration SQL, ignoring comments", () => {
    expect(rolesCreatedBy(GUARDED)).toEqual(["fixture_reader"]);
    expect(rolesCreatedBy(UNGUARDED)).toEqual(["fixture_writer"]);
  });

  test("tells a role created only when missing from one created unconditionally", () => {
    expect(unguardedRolesCreatedBy(GUARDED)).toEqual([]);
    expect(unguardedRolesCreatedBy(UNGUARDED)).toEqual(["fixture_writer"]);
    // A check for another role does not guard this one.
    expect(
      unguardedRolesCreatedBy(
        GUARDED.replace("CREATE ROLE fixture_reader", "CREATE ROLE other_role"),
      ),
    ).toEqual(["other_role"]);
  });

  test("a check counts only for the CREATE ROLE inside its own conditional", () => {
    // A bare existence check guards nothing.
    expect(
      unguardedRolesCreatedBy(`SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture_reader');
CREATE ROLE fixture_reader NOLOGIN;`),
    ).toEqual(["fixture_reader"]);
    // A guarded creation does not cover a later unconditional one.
    expect(
      unguardedRolesCreatedBy(`${GUARDED}--> statement-breakpoint
CREATE ROLE fixture_reader NOLOGIN;`),
    ).toEqual(["fixture_reader"]);
    // A creation before the conditional is not inside it.
    expect(
      unguardedRolesCreatedBy(`CREATE ROLE fixture_reader NOLOGIN;--> statement-breakpoint
${GUARDED}`),
    ).toEqual(["fixture_reader"]);
    // Nested conditionals and an IF NOT EXISTS table inside the block keep
    // the creation inside the guard.
    expect(
      unguardedRolesCreatedBy(`DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture_reader') THEN
    CREATE TABLE IF NOT EXISTS fixture_table (id int);
    IF current_setting('server_version_num')::int > 150000 THEN
      PERFORM 1;
    END IF;
    CREATE ROLE fixture_reader NOLOGIN;
  END IF;
END
$$;`),
    ).toEqual([]);
  });

  test("collects every migration's roles from a migrations directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "migration-roles-"));
    try {
      for (const [name, sql] of [
        ["0002_writer", UNGUARDED],
        ["0001_reader", GUARDED],
        ["0003_tables", "CREATE TABLE fixture (id int);"],
      ] as const) {
        mkdirSync(path.join(dir, name));
        writeFileSync(path.join(dir, name, "migration.sql"), sql);
      }
      expect(migrationRoleCreations(dir)).toEqual([
        { migration: "0001_reader", roles: ["fixture_reader"] },
        { migration: "0002_writer", roles: ["fixture_writer"] },
      ]);
      expect(migrationCreatedRoles(dir)).toEqual([
        "fixture_reader",
        "fixture_writer",
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("the local reset drops every role a migration creates", () => {
    const created = migrationRoleCreations(DRIZZLE_DIR).flatMap(
      ({ roles }) => roles,
    );
    expect(created.length).toBeGreaterThan(0);
    // The reset reads the same list, so a new role cannot be left behind.
    expect(migrationCreatedRoles(DRIZZLE_DIR).toSorted()).toEqual(
      [...new Set(created)].toSorted(),
    );
    const reset = readFileSync(
      path.resolve(import.meta.dir, "seed-reset.ts"),
      "utf-8",
    );
    expect(reset).toContain("migrationCreatedRoles(");
    expect(reset).toContain("DROP ROLE IF EXISTS");
  });

  test("a new migration creates a role only when it is missing", () => {
    const unguarded = migrationRoleCreations(DRIZZLE_DIR)
      .map(({ migration }) => ({
        migration,
        roles: unguardedRolesCreatedBy(
          readFileSync(
            path.join(DRIZZLE_DIR, migration, "migration.sql"),
            "utf-8",
          ),
        ),
      }))
      .filter(({ roles }) => roles.length > 0)
      .map(({ migration }) => migration);
    expect(
      unguarded.filter(
        (migration) => !UNGUARDED_ROLE_MIGRATIONS.has(migration),
      ),
    ).toEqual([]);
    // Shrink-only: every listed migration still exists and still needs it.
    expect(
      [...UNGUARDED_ROLE_MIGRATIONS].filter(
        (migration) => !unguarded.includes(migration),
      ),
    ).toEqual([]);
  });
});
