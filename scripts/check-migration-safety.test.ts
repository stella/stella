import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drawPropertySamples, propertyConfig } from "@stll/property-testing";

import { checkMigrationSources } from "./check-migration-safety";

type CheckerResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const decoder = new TextDecoder();

const TIMEOUTS = `
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
`;

const runCheckerOn = (...args: string[]): CheckerResult => {
  const result = Bun.spawnSync([
    "bun",
    "scripts/check-migration-safety.ts",
    ...args,
  ]);

  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const runCheckerOnSource = (sql: string): CheckerResult => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "stella-migration-safety-"),
  );
  const file = path.join(directory, "migration.sql");

  writeFileSync(file, sql);

  try {
    return runCheckerOn(file);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

// Every fixture sets the timeouts the file invariants require, so each test
// exercises only the rule it names.
const runChecker = (sql: string): CheckerResult =>
  runCheckerOnSource(`${TIMEOUTS}${sql}`);

const expectClean = (result: CheckerResult) => {
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
};

// Property samples run the checker in process. Outside the repository, like
// the temporary files runChecker writes, so a corpus read sorts it first.
const PROPERTY_MIGRATION = "../property-sample/migration.sql";

const findingsIn = (sql: string) =>
  checkMigrationSources([
    { file: PROPERTY_MIGRATION, source: `${TIMEOUTS}${sql}` },
  ]).flatMap(({ invariantFindings, guardedFindings, acknowledgementErrors }) =>
    invariantFindings.concat(guardedFindings, acknowledgementErrors),
  );

const expectFinding = (result: CheckerResult, ruleId: string) => {
  expect(result.stderr).toContain(`[${ruleId}]`);
  expect(result.exitCode).toBe(1);
};

describe("check-migration-safety", () => {
  describe("baseline", () => {
    it("passes the full no-argument scan of the migration tree", () => {
      // The default scan walks every migration not listed in the baseline, so
      // the standalone checker stays usable for developers.
      expectClean(runCheckerOn());
    });

    it("skips a baselined applied migration", () => {
      const result = runCheckerOn(
        "apps/api/drizzle/20260429220500_global-search-unaccent/migration.sql",
      );

      expect(result.stdout).toContain("Skipping");
      expectClean(result);
    });

    it("lists only migration files that exist", () => {
      const entries = readFileSync("scripts/migration-baseline.txt", "utf-8")
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      for (const entry of entries) {
        expect(Bun.file(entry).size).toBeGreaterThan(0);
      }
    });
  });

  describe("file invariants", () => {
    it("requires lock_timeout and statement_timeout", () => {
      const result = runCheckerOnSource(`
        ALTER TABLE "documents" ADD COLUMN "status" text;
      `);

      expectFinding(result, "missing-lock-timeout");
      expect(result.stderr).toContain("[missing-statement-timeout]");
    });

    it("requires the timeouts before the first migration operation", () => {
      const result = runCheckerOnSource(`
        ALTER TABLE "documents" ADD COLUMN "status" text;
        SET LOCAL lock_timeout = '1s';
        SET LOCAL statement_timeout = '30s';
      `);

      expectFinding(result, "missing-lock-timeout");
      expect(result.stderr).toContain("[missing-statement-timeout]");
    });

    it("accepts session-level timeouts around a split transaction", () => {
      expectClean(
        runCheckerOnSource(`
          SET lock_timeout = '1s';
          SET statement_timeout = '10min';
          COMMIT;
          CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_status_idx" ON "documents" ("status");
          BEGIN;
        `),
      );
    });
  });

  describe("statement invariants", () => {
    it("rejects column-target ON CONFLICT clauses", () => {
      const result = runChecker(`
        INSERT INTO "mcp_connectors" ("slug")
        VALUES ('salvia')
        ON CONFLICT ("slug") DO NOTHING;
      `);

      expectFinding(result, "on-conflict-column-target");
      expect(result.stderr).toContain("WHERE NOT EXISTS");
    });

    it("allows named-constraint ON CONFLICT clauses", () => {
      expectClean(
        runChecker(`
          INSERT INTO "practice_areas" ("slug")
          VALUES ('corporate')
          ON CONFLICT ON CONSTRAINT "practice_areas_slug_unique" DO NOTHING;
        `),
      );
    });

    it("allows partial-index idempotence via WHERE NOT EXISTS", () => {
      expectClean(
        runChecker(`
          INSERT INTO "mcp_connectors" ("slug", "organization_id")
          SELECT 'salvia', NULL
          WHERE NOT EXISTS (
            SELECT 1
            FROM "mcp_connectors"
            WHERE "slug" = 'salvia'
              AND "organization_id" IS NULL
          );
        `),
      );
    });
  });

  describe("unbounded-update", () => {
    it("flags a full-table UPDATE with no WHERE clause", () => {
      expectFinding(
        runChecker(`UPDATE "documents" SET "status" = 'archived';`),
        "unbounded-update",
      );
    });

    it("flags a tautological WHERE clause", () => {
      expectFinding(
        runChecker(`UPDATE "documents" SET "status" = 'archived' WHERE true;`),
        "unbounded-update",
      );
      expectFinding(
        runChecker(`UPDATE "documents" SET "status" = 'archived' WHERE 1 = 1;`),
        "unbounded-update",
      );
    });

    it("allows an UPDATE bounded by a WHERE clause", () => {
      expectClean(
        runChecker(
          `UPDATE "documents" SET "status" = 'archived' WHERE "id" = 2;`,
        ),
      );
    });

    it("allows an INSERT ... ON CONFLICT DO UPDATE SET upsert", () => {
      expectClean(
        runChecker(`
          INSERT INTO "documents" ("id", "status") VALUES (1, 'archived')
          ON CONFLICT ON CONSTRAINT "documents_pkey" DO UPDATE SET "status" = EXCLUDED."status";
        `),
      );
    });

    it("flags a CTE upsert wrapping an unbounded outer UPDATE", () => {
      expectFinding(
        runChecker(`
          WITH "seed" AS (
            INSERT INTO "documents" ("id", "status") VALUES (1, 'archived')
            ON CONFLICT ON CONSTRAINT "documents_pkey" DO NOTHING RETURNING "id"
          )
          UPDATE "documents" SET "status" = 'archived';
        `),
        "unbounded-update",
      );
    });

    it("flags an unbounded UPDATE inside a data-modifying CTE", () => {
      expectFinding(
        runChecker(`
          WITH "u" AS (
            UPDATE "documents" SET "status" = 'archived' RETURNING "id"
          )
          SELECT count(*) FROM "u";
        `),
        "unbounded-update",
      );
    });

    it("allows a WHERE-bounded UPDATE inside a data-modifying CTE", () => {
      expectClean(
        runChecker(`
          WITH "u" AS (
            UPDATE "documents" SET "status" = 'archived' WHERE "id" = 2 RETURNING "id"
          )
          SELECT count(*) FROM "u";
        `),
      );
    });

    it("flags an unbounded UPDATE inside a DO block", () => {
      expectFinding(
        runChecker(`
          DO $$
          BEGIN
            UPDATE "documents" SET "status" = 'archived';
          END
          $$;
        `),
        "unbounded-update",
      );
    });

    it("allows a CREATE POLICY ... FOR UPDATE clause", () => {
      expectClean(
        runChecker(`
          CREATE POLICY "documents_update" ON "documents"
          FOR UPDATE USING ("organization_id" = current_setting('app.org')::uuid);
        `),
      );
    });

    it("allows a CREATE TRIGGER ... BEFORE UPDATE definition", () => {
      expectClean(
        runChecker(`
          CREATE TRIGGER "documents_touch" BEFORE UPDATE ON "documents"
          FOR EACH ROW EXECUTE FUNCTION "touch_updated_at"();
        `),
      );
    });

    it("flags a full-table UPDATE whose only WHERE is in a SET subquery", () => {
      expectFinding(
        runChecker(`
          UPDATE "documents"
          SET "workspace_id" = (
            SELECT "id" FROM "workspaces" WHERE "workspaces"."slug" = 'x'
          );
        `),
        "unbounded-update",
      );
    });

    it("allows a FROM-join UPDATE bounded by a top-level WHERE", () => {
      expectClean(
        runChecker(`
          UPDATE "documents" AS d
          SET "workspace_id" = w."id"
          FROM "workspaces" AS w
          WHERE d."workspace_slug" = w."slug";
        `),
      );
    });
  });

  describe("other backfill rules", () => {
    it("flags INSERT ... SELECT ... FROM a relation", () => {
      expectFinding(
        runChecker(`
          INSERT INTO "documents_v2" ("id", "status")
          SELECT "id", "status" FROM "documents";
        `),
        "insert-select",
      );
    });

    it("flags MERGE, CREATE TABLE AS, and materialized-view population", () => {
      expectFinding(
        runChecker(`
          MERGE INTO "documents" d USING "staged" s ON d."id" = s."id"
          WHEN MATCHED THEN UPDATE SET "status" = s."status";
        `),
        "merge",
      );
      expectFinding(
        runChecker(
          `CREATE TABLE "documents_copy" AS SELECT * FROM "documents";`,
        ),
        "create-table-as",
      );
      expectFinding(
        runChecker(
          `CREATE MATERIALIZED VIEW "document_counts" AS SELECT count(*) FROM "documents";`,
        ),
        "materialized-view-populate",
      );
    });

    it("allows a materialized view created WITH NO DATA", () => {
      expectClean(
        runChecker(
          `CREATE MATERIALIZED VIEW "document_counts" AS SELECT count(*) FROM "documents" WITH NO DATA;`,
        ),
      );
    });

    it("flags a recursive CTE", () => {
      expectFinding(
        runChecker(`
          WITH RECURSIVE "ancestors" AS (
            SELECT "id", "parent_id" FROM "matters" WHERE "id" = 1
            UNION ALL
            SELECT "m"."id", "m"."parent_id"
            FROM "matters" "m"
            JOIN "ancestors" "a" ON "m"."id" = "a"."parent_id"
          )
          UPDATE "matters" SET "depth" = 0 WHERE "id" IN (SELECT "id" FROM "ancestors");
        `),
        "recursive-cte",
      );
    });
  });

  describe("destructive rules", () => {
    it("flags enum value renames, unlogged tables, and disabled triggers", () => {
      expectFinding(
        runChecker(
          `ALTER TYPE "document_status" RENAME VALUE 'draft' TO 'pending';`,
        ),
        "rename-enum-value",
      );
      expectFinding(
        runChecker(`ALTER TABLE "documents" SET UNLOGGED;`),
        "set-unlogged",
      );
      expectFinding(
        runChecker(`ALTER TABLE "documents" DISABLE TRIGGER ALL;`),
        "disable-trigger",
      );
    });

    it("classifies DROP IDENTITY as its own rule, not a column drop", () => {
      const result = runChecker(
        `ALTER TABLE "documents" ALTER COLUMN "id" DROP IDENTITY;`,
      );

      expectFinding(result, "drop-column-identity");
      expect(result.stderr).not.toContain("[drop-column]");
    });

    it("treats DROP INDEX followed by CREATE INDEX of the same name as a rebuild", () => {
      expectClean(
        runChecker(`
          DROP INDEX CONCURRENTLY IF EXISTS "documents_status_idx";
          CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_status_idx" ON "documents" ("status");
        `),
      );
    });

    it("does not match a rebuild across schemas", () => {
      expectFinding(
        runChecker(`
          DROP INDEX IF EXISTS "audit"."documents_status_idx";
          CREATE INDEX IF NOT EXISTS "documents_status_idx" ON "documents" ("status");
        `),
        "drop-object",
      );
    });

    // .squawk.toml excludes squawk's ban-drop-function because this rule owns
    // function drops; pin that the acknowledgement is still required.
    it("requires a reviewed drop-object acknowledgement for DROP FUNCTION", () => {
      expectFinding(
        runChecker(`DROP FUNCTION "documents_is_live"(jsonb);`),
        "drop-object",
      );
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object, rollback-contract - every caller was replaced above
          DROP FUNCTION "documents_is_live"(jsonb);
        `),
      );
    });

    it("still flags a DROP INDEX with no matching CREATE", () => {
      expectFinding(
        runChecker(`
          DROP INDEX CONCURRENTLY IF EXISTS "documents_status_idx";
          CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_other_idx" ON "documents" ("other");
        `),
        "drop-object",
      );
    });

    it("ignores stored-routine bodies", () => {
      // CREATE FUNCTION only stores the body; nothing in it runs during the
      // migration.
      expectClean(
        runChecker(`
          CREATE OR REPLACE FUNCTION "archive_all"() RETURNS void AS $$
          BEGIN
            DELETE FROM "documents";
            UPDATE "documents" SET "status" = 'archived';
          END
          $$ LANGUAGE plpgsql;
        `),
      );
    });
  });

  describe("access-control rules", () => {
    it("flags broad grants: PUBLIC, ALL, GRANT OPTION, role membership, defaults", () => {
      for (const grant of [
        `GRANT SELECT ON "documents" TO PUBLIC;`,
        `GRANT ALL ON "documents" TO "reporting";`,
        `GRANT SELECT ON "documents" TO "reporting" WITH GRANT OPTION;`,
        `GRANT "stella_reader" TO "reporting";`,
        `GRANT pg_read_all_data TO "reporting";`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "reporting";`,
      ]) {
        expectFinding(runChecker(grant), "grant-privileges");
      }
    });

    it("allows routine table grants to a named role and role-scoped true policies", () => {
      expectClean(
        runChecker(`
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "documents" TO stella;
          GRANT SELECT (id, name) ON "documents" TO "reporting";
          GRANT USAGE ON SCHEMA public TO "reporting";
          CREATE POLICY "documents_ingestion" ON "documents"
            AS PERMISSIVE FOR ALL TO "stella_ingestion"
            USING (true) WITH CHECK (true);
        `),
      );
    });

    it("flags policy changes and privilege escalation surfaces", () => {
      expectFinding(
        runChecker(
          `CREATE POLICY "documents_all" ON "documents" FOR SELECT TO PUBLIC USING (true);`,
        ),
        "permissive-policy",
      );
      // No USING and no WITH CHECK defaults to permitting every row for PUBLIC.
      expectFinding(
        runChecker(`CREATE POLICY "documents_open" ON "documents";`),
        "permissive-policy",
      );
      expectFinding(
        runChecker(
          `ALTER POLICY "documents_select" ON "documents" USING (true);`,
        ),
        "alter-policy",
      );
      expectFinding(
        runChecker(
          `CREATE POLICY "documents_all" ON "documents" FOR SELECT USING (true);`,
        ),
        "permissive-policy",
      );
      expectFinding(
        runChecker(`
          CREATE FUNCTION "lookup"() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
            SELECT 1;
          $$;
        `),
        "security-definer",
      );
      expectFinding(
        runChecker(`ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;`),
        "disable-row-level-security",
      );
    });

    it("allows REVOKE, which only tightens access", () => {
      expectClean(runChecker(`REVOKE ALL ON "documents" FROM PUBLIC;`));
    });
  });

  describe("acknowledgements", () => {
    it("clears a finding when the acknowledgement names its rule", () => {
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed unbounded-update - table has under ten rows
          UPDATE "documents" SET "status" = 'archived';
        `),
      );
    });

    it("clears several rules on one statement", () => {
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed drop-column, disable-trigger, rollback-contract - column unused
          -- since v0.7; trigger re-enabled in the next statement after the rewrite
          ALTER TABLE "documents" DROP COLUMN "legacy_status", DISABLE TRIGGER ALL;
          ALTER TABLE "documents" ENABLE TRIGGER ALL;
        `),
      );
    });

    it("does not let an acknowledgement for one rule clear another", () => {
      expectFinding(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object - rollback handled separately
          UPDATE "documents" SET "status" = 'archived';
        `),
        "unbounded-update",
      );
    });

    it("scopes an acknowledgement to the statement directly below it", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed drop-object - replaced by documents_v2
        DROP TABLE "documents_old";
        DROP TABLE "documents";
      `);

      expectFinding(result, "drop-object");
      expect(result.stderr.match(/\[drop-object\]/gu)).toHaveLength(1);
    });

    it("lets an acknowledgement above a DO block cover its inner statements", () => {
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed unbounded-update - guarded by the row
          -- count check inside the block
          DO $$
          BEGIN
            IF (SELECT count(*) FROM "documents") < 100 THEN
              UPDATE "documents" SET "status" = 'archived';
            END IF;
          END
          $$;
        `),
      );
    });

    it("counts a multi-line reason", () => {
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object, rollback-contract - see
          -- the replacement table created in the previous migration
          DROP TABLE "documents_old";
        `),
      );
    });

    it("rejects a listed rule id that clears nothing on a multi-rule acknowledgement", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed drop-object, security-definer - replaced by documents_v2
        DROP TABLE "documents";
      `);

      expectFinding(result, "unused-acknowledgement");
      expect(result.stderr).toContain("acknowledgement for security-definer");
    });

    it("rejects an acknowledgement that clears nothing", () => {
      expectFinding(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object - nothing here drops anything
          ALTER TABLE "documents" ADD COLUMN "status" text;
        `),
        "unused-acknowledgement",
      );
    });

    it("rejects an unknown rule id, including the retired category names", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed destructive-change - replaced by documents_v2
        DROP TABLE "documents";
      `);

      expectFinding(result, "unknown-acknowledgement-rule");
      expect(result.stderr).toContain("[drop-object]");
    });

    it("rejects a reason that is too short", () => {
      expectFinding(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object - ok
          DROP TABLE "documents";
        `),
        "acknowledgement-reason-too-short",
      );
    });

    it("rejects a malformed marker", () => {
      expectFinding(
        runChecker(`
          -- stella-migration-safety: reviewed drop-object
          DROP TABLE "documents";
        `),
        "malformed-acknowledgement",
      );
    });
  });

  describe("masking", () => {
    const UNSAFE_FRAGMENTS = [
      `DROP TABLE "documents"`,
      `UPDATE "documents" SET "status" = 'x'`,
      `GRANT ALL ON "documents" TO PUBLIC`,
      `ON CONFLICT ("slug") DO NOTHING`,
      `DELETE FROM "documents"`,
      `SECURITY DEFINER`,
    ];

    const wrappers: ((fragment: string) => string)[] = [
      (fragment) => `SELECT 1; -- ${fragment}\n`,
      (fragment) => `SELECT 1; /* ${fragment} */`,
      (fragment) => `SELECT '${fragment.replace(/'/gu, "''")}';`,
      (fragment) => `SELECT E'${fragment.replace(/['\\]/gu, "\\$&")}';`,
      (fragment) => `SELECT 1 AS "${fragment.replace(/"/gu, '""')}";`,
      (fragment) => `SELECT $tag$${fragment}$tag$;`,
    ];

    const maskedSql = fc
      .tuple(
        fc.constantFrom(...UNSAFE_FRAGMENTS),
        fc.constantFrom(...wrappers),
        fc.constantFrom(...wrappers),
      )
      .map(
        ([fragment, first, second]) =>
          `${first(fragment)}\n${second(fragment)}`,
      );

    const executedSql = fc
      .tuple(
        fc.constantFrom(...UNSAFE_FRAGMENTS.slice(0, 5)),
        fc.constantFrom(...wrappers),
      )
      .map(([fragment, wrapper]) => {
        const executable = fragment.startsWith("ON CONFLICT")
          ? `INSERT INTO "documents" ("slug") VALUES ('x') ${fragment};`
          : `${fragment};`;
        return `${wrapper(fragment)}\n${executable}`;
      });

    it("never fires on unsafe SQL inside comments, literals, or identifiers", () => {
      fc.assert(
        fc.property(maskedSql, (sql) => {
          expect(findingsIn(sql)).toEqual([]);
        }),
        propertyConfig({ numRuns: 30 }),
      );
    });

    it("always fires on the same unsafe SQL when it executes", () => {
      fc.assert(
        fc.property(executedSql, (sql) => {
          expect(findingsIn(sql).length).toBeGreaterThan(0);
        }),
        propertyConfig({ numRuns: 20 }),
      );
    });

    // The spawned CLI must agree with the in-process verdict the properties
    // assert: no finding exactly when it prints no error and exits 0. Ten
    // spawns measure ~1 s; 30 s leaves a cold runner a margin above 20x.
    it("the CLI reports exactly the in-process findings for drawn samples", () => {
      for (const { value: sql, label } of [
        ...drawPropertySamples(maskedSql, { numRuns: 5 }).map(
          ({ value, label: drawn }) => ({ value, label: `maskedSql ${drawn}` }),
        ),
        ...drawPropertySamples(executedSql, { numRuns: 5 }).map(
          ({ value, label: drawn }) => ({
            value,
            label: `executedSql ${drawn}`,
          }),
        ),
      ]) {
        const findings = findingsIn(sql);
        const result = runChecker(sql);
        expect(result.exitCode, label).toBe(findings.length > 0 ? 1 : 0);
        expect(result.stderr === "", label).toBe(findings.length === 0);
        for (const { ruleId } of findings) {
          expect(result.stderr, label).toContain(`[${ruleId}]`);
        }
      }
    }, 30_000);
  });

  describe("high-volume-table-dml", () => {
    // The shape that outran the migration budget on a corpus-sized table: a
    // filtered UPDATE whose predicate the table cannot serve from an index.
    const CITATION_REOPEN = `
      WITH affected AS (
        SELECT "id", "citation_key"
          FROM "case_law_decisions"
         WHERE "decision_date" >= ((now() AT TIME ZONE 'UTC')::date + 2)
      )
      UPDATE "case_law_citations" c
         SET "resolution_status" = 'pending',
             "cited_decision_id" = NULL
       WHERE c."resolution_status" <> 'pending'
         AND (
              c."citing_decision_id" IN (SELECT "id" FROM affected)
           OR c."cited_decision_id" IN (SELECT "id" FROM affected)
           OR c."citation_key" IN (SELECT "citation_key" FROM affected)
         );
    `;

    it("rejects a filtered UPDATE of a high-volume table", () => {
      const result = runChecker(CITATION_REOPEN);

      expectFinding(result, "high-volume-table-dml");
      expect(result.stderr).toContain("online repair");
    });

    it("cannot be acknowledged", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed high-volume-table-dml - bounded by the date index, a handful of rows
        ${CITATION_REOPEN}
      `);

      expectFinding(result, "high-volume-table-dml");
      expectFinding(result, "unacknowledgeable-rule");
    });

    it("rejects DELETE, INSERT ... SELECT and MERGE against a registered table", () => {
      expectFinding(
        runChecker(
          `DELETE FROM public."case_law_decisions" WHERE "id" = '00000000-0000-0000-0000-000000000000';`,
        ),
        "high-volume-table-dml",
      );
      // A qualifier with whitespace around its dot is the same relation.
      expectFinding(
        runChecker(
          `UPDATE ONLY "public" . case_law_decisions SET "content_hash" = NULL WHERE "id" = 'x';`,
        ),
        "high-volume-table-dml",
      );
      expectFinding(
        runChecker(`
          INSERT INTO case_law_search_documents ("decision_id")
          SELECT "id" FROM "case_law_decisions" WHERE "content_hash" IS NULL;
        `),
        "high-volume-table-dml",
      );
      expectFinding(
        runChecker(`
          MERGE INTO "case_law_citations" c
          USING "case_law_decisions" d ON d."id" = c."cited_decision_id"
          WHEN MATCHED THEN UPDATE SET "resolution_status" = 'pending';
        `),
        "high-volume-table-dml",
      );
    });

    it("allows the same statements against an unregistered table", () => {
      expectClean(
        runChecker(`
          UPDATE "case_law_polarity_rules"
             SET "source" = 'retired'
           WHERE "pattern" = 'x';
        `),
      );
    });

    it("allows DDL, seed rows and row locks on a registered table", () => {
      expectClean(
        runChecker(`
          ALTER TABLE "case_law_citations" ADD COLUMN "note" text;
          INSERT INTO "case_law_decisions" ("id") VALUES ('x')
            ON CONFLICT ON CONSTRAINT "case_law_decisions_pkey" DO UPDATE SET "id" = 'x';
          SELECT "id" FROM "case_law_decisions" WHERE "id" = 'x' FOR UPDATE;
        `),
      );
    });

    it("rejects the index-job backfill that outran the migration budget", () => {
      // The trail carries one row per document per index operation and has no
      // index on `operation`, so this filtered UPDATE scans it whole. It is
      // registered now; the repair belongs to a bounded online pass.
      const result = runChecker(`
        UPDATE "case_law_index_jobs"
          SET "detail" = "error_message", "error_message" = NULL
          WHERE "operation" = 'withdraw'
            AND "status" = 'succeeded'
            AND "error_message" IS NOT NULL;
      `);

      expectFinding(result, "high-volume-table-dml");
      expectFinding(
        runChecker(`
          UPDATE "legislation_index_jobs"
            SET "detail" = "error_message", "error_message" = NULL
            WHERE "operation" = 'withdraw';
        `),
        "high-volume-table-dml",
      );
    });

    it("ignores the table name inside comments, strings and routine bodies", () => {
      expectClean(
        runChecker(`
          -- UPDATE "case_law_citations" SET "resolution_status" = 'pending';
          /* DELETE FROM case_law_decisions; */
          INSERT INTO "audit_notes" ("body")
            VALUES ('UPDATE case_law_citations SET resolution_status = NULL');
          CREATE OR REPLACE FUNCTION repair_later() RETURNS void AS $$
            UPDATE "case_law_citations" SET "resolution_status" = 'pending';
          $$ LANGUAGE sql;
        `),
      );
    });
  });

  describe("code-owned-table-write", () => {
    // The seed that left clean and upgraded databases with different rows.
    const REGISTRATION_SWEEP_SEED = `
      INSERT INTO "scheduler_jobs" ("id", "task", "description", "schedule", "enabled", "next_run_at")
      VALUES ('auth.sweepRegistrations.hour', 'auth.sweepRegistrations', 'Delete expired unused registrations', '{"type":"interval","everyMs":3600000}', true, now())
      ON CONFLICT ON CONSTRAINT "scheduler_jobs_pkey" DO NOTHING;
    `;

    it("rejects the migration-seeded scheduler job", () => {
      const result = runChecker(REGISTRATION_SWEEP_SEED);

      expectFinding(result, "code-owned-table-write");
      expect(result.stderr).toContain("[volatile-data-write]");
      expect(result.stderr).toContain("DECLARED_SCHEDULER_JOBS");
    });

    it("cannot be acknowledged", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed code-owned-table-write - the boot sync upserts the same row anyway
        ${REGISTRATION_SWEEP_SEED}
      `);

      expectFinding(result, "code-owned-table-write");
      expectFinding(result, "unacknowledgeable-rule");
    });

    it("rejects every insert, update and merge of a code-owned table", () => {
      const writes = [
        `INSERT INTO "scheduler_jobs" ("id", "enabled") VALUES ('x.hour', true);`,
        `INSERT INTO public.scheduler_jobs ("id") SELECT 'x.hour' WHERE NOT EXISTS (SELECT 1 FROM "scheduler_jobs" WHERE "id" = 'x.hour');`,
        `UPDATE "scheduler_jobs" SET "enabled" = false WHERE "id" = 'x.hour';`,
        `UPDATE ONLY "public" . "scheduler_jobs" SET "schedule" = '{}' WHERE "id" = 'x.hour';`,
        `WITH retired AS (SELECT 'x.hour' AS id) UPDATE scheduler_jobs SET "enabled" = false FROM retired WHERE scheduler_jobs."id" = retired.id;`,
        `MERGE INTO "scheduler_jobs" j USING (VALUES ('x.hour')) v(id) ON j."id" = v.id WHEN NOT MATCHED THEN INSERT ("id") VALUES (v.id);`,
        `DO $$ BEGIN INSERT INTO "scheduler_jobs" ("id") VALUES ('x.hour'); END $$;`,
        // A comment is whitespace between any two tokens.
        `INSERT /* seed */ INTO "scheduler_jobs" ("id") VALUES ('x.hour');`,
        `INSERT -- seed\n INTO scheduler_jobs ("id") VALUES ('x.hour');`,
        `UPDATE /* a */ ONLY /* b */ "public" /* c */ . /* d */ "scheduler_jobs" SET "enabled" = false WHERE "id" = 'x.hour';`,
        `MERGE /* m */ INTO public./* t */scheduler_jobs j USING (VALUES ('x.hour')) v(id) ON j."id" = v.id WHEN NOT MATCHED THEN INSERT ("id") VALUES (v.id);`,
      ];

      for (const sql of writes) {
        expect([
          sql,
          findingsIn(sql).some(
            ({ ruleId }) => ruleId === "code-owned-table-write",
          ),
        ]).toEqual([sql, true]);
      }
    });

    it("allows deletes, DDL and mentions that write nothing", () => {
      expectClean(
        runChecker(`
          -- stella-migration-safety: reviewed delete-data - one row by primary key, recreated from code at boot
          DELETE FROM "scheduler_jobs" WHERE "id" = 'auth.sweepRegistrations.hour';
          ALTER TABLE "scheduler_jobs" ADD COLUMN "note" text;
          SELECT "id" FROM "scheduler_jobs" WHERE "id" = 'x' FOR UPDATE;
          -- INSERT INTO "scheduler_jobs" ("id") VALUES ('x');
          INSERT INTO "audit_notes" ("body")
            VALUES ('UPDATE scheduler_jobs SET enabled = false');
          CREATE OR REPLACE FUNCTION reschedule_later() RETURNS void AS $$
            UPDATE "scheduler_jobs" SET "enabled" = false;
          $$ LANGUAGE sql;
        `),
      );
    });

    it("passes the migration that removes the seeded job", () => {
      expectClean(
        runCheckerOn(
          "apps/api/drizzle/20261004104000_unseed_registration_sweep_job/migration.sql",
        ),
      );
    });
  });

  describe("volatile-data-write", () => {
    const VOLATILE_VALUES = [
      "now()",
      "pg_catalog.now()",
      "NOW ()",
      "current_timestamp",
      "CURRENT_TIMESTAMP(3)",
      "current_date",
      "current_time",
      "localtimestamp",
      "localtime",
      "clock_timestamp()",
      "statement_timestamp()",
      "transaction_timestamp()",
      "timeofday()",
      "random()",
      "gen_random_uuid()",
      "uuid_generate_v4()",
      "uuidv7()",
    ];
    const WRITE_SHAPES = [
      (value: string) =>
        `INSERT INTO "practice_areas" ("slug", "created_at") VALUES ('corporate', ${value});`,
      (value: string) =>
        `INSERT INTO "practice_areas" ("id", "slug") SELECT ${value}, v.slug FROM (VALUES ('corporate')) v(slug);`,
      (value: string) =>
        `UPDATE "practice_areas" SET "updated_at" = ${value} WHERE "slug" = 'corporate';`,
      (value: string) =>
        `INSERT INTO "practice_areas" ("slug") VALUES ('corporate') ON CONFLICT ON CONSTRAINT "practice_areas_slug_unique" DO UPDATE SET "updated_at" = ${value};`,
      (value: string) =>
        `MERGE INTO "practice_areas" p USING (VALUES ('corporate')) v(slug) ON p."slug" = v.slug WHEN MATCHED THEN UPDATE SET "updated_at" = ${value};`,
      (value: string) =>
        `DO $$ BEGIN UPDATE "practice_areas" SET "updated_at" = ${value} WHERE "slug" = 'corporate'; END $$;`,
    ];

    it("rejects every volatile value in every row-writing shape", () => {
      for (const value of VOLATILE_VALUES) {
        for (const shape of WRITE_SHAPES) {
          const sql = shape(value);
          expect([
            sql,
            findingsIn(sql).some(
              ({ ruleId }) => ruleId === "volatile-data-write",
            ),
          ]).toEqual([sql, true]);
        }
      }
    });

    it("cannot be acknowledged", () => {
      const result = runChecker(`
        -- stella-migration-safety: reviewed volatile-data-write - the column default is volatile anyway
        UPDATE "practice_areas" SET "updated_at" = now() WHERE "slug" = 'corporate';
      `);

      expectFinding(result, "volatile-data-write");
      expectFinding(result, "unacknowledgeable-rule");
    });

    it("allows volatile column defaults, DEFAULT writes, deletes and inert mentions", () => {
      expectClean(
        runChecker(`
          CREATE TABLE "practice_area_notes" (
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
          ALTER TABLE "practice_areas" ADD COLUMN "seen_at" timestamptz DEFAULT clock_timestamp();
          ALTER TABLE "practice_areas" ALTER COLUMN "updated_at" SET DEFAULT current_timestamp;
          INSERT INTO "practice_areas" ("id", "slug", "created_at") VALUES (DEFAULT, 'corporate', DEFAULT);
          UPDATE "practice_areas" SET "updated_at" = DEFAULT WHERE "slug" = 'corporate';
          -- stella-migration-safety: reviewed delete-data - expired rows only, the sweeper deletes them anyway
          DELETE FROM "verification" WHERE "expires_at" < now();
          -- UPDATE "practice_areas" SET "updated_at" = now();
          INSERT INTO "audit_notes" ("body") VALUES ('set at now() by random()');
          UPDATE "practice_areas" SET "now" = 'x' WHERE "slug" = 'corporate';
          CREATE OR REPLACE FUNCTION touch_practice_area() RETURNS trigger AS $$
          BEGIN
            UPDATE "practice_areas" SET "updated_at" = now() WHERE "id" = NEW."id";
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `),
      );
    });
  });

  describe("rollback-contract", () => {
    const rollbackFindings = (sql: string) =>
      findingsIn(sql).filter(({ ruleId }) => ruleId === "rollback-contract");

    it.each([
      [`DROP TABLE "documents";`, "drops table or view public.documents"],
      [
        `DROP MATERIALIZED VIEW IF EXISTS "document_stats";`,
        "public.document_stats",
      ],
      [
        `ALTER TABLE "documents" DROP COLUMN "legacy";`,
        "drops column public.documents.legacy",
      ],
      [
        `ALTER TABLE "documents" RENAME COLUMN "title" TO "name";`,
        "renames column public.documents.title",
      ],
      [
        `ALTER TABLE "documents" RENAME TO "files";`,
        "renames table or view public.documents",
      ],
      [
        `ALTER TABLE "documents" ALTER COLUMN "size" TYPE bigint;`,
        "changes the type of column public.documents.size",
      ],
      [
        `ALTER TABLE "documents" ALTER COLUMN "title" SET NOT NULL;`,
        "makes NOT NULL column public.documents.title",
      ],
      [
        `ALTER TABLE "documents" ALTER COLUMN "status" DROP DEFAULT;`,
        "drops the default of column public.documents.status",
      ],
      [
        `ALTER TABLE "documents" ADD COLUMN "owner_id" text NOT NULL;`,
        "adds a NOT NULL column without a default: public.documents.owner_id",
      ],
      [
        `ALTER TABLE "documents" ADD CONSTRAINT "documents_status_check" CHECK ("status" IN ('draft')) NOT VALID;`,
        "adds constraint documents_status_check on public.documents",
      ],
      [
        `CREATE UNIQUE INDEX CONCURRENTLY "documents_title_key" ON "documents" ("title");`,
        "adds unique index documents_title_key on public.documents",
      ],
      [`DROP TYPE "document_status";`, "drops type public.document_status"],
      [
        `ALTER TYPE "document_status" RENAME VALUE 'draft' TO 'pending';`,
        "renames a value of enum public.document_status",
      ],
      [
        `DROP FUNCTION "documents_is_live"(jsonb);`,
        "drops routine public.documents_is_live",
      ],
      [
        `ALTER FUNCTION "documents_is_live"(jsonb) RENAME TO "documents_live";`,
        "renames routine public.documents_is_live",
      ],
    ])("flags %s", (sql, description) => {
      expect(
        rollbackFindings(sql).map((finding) => finding.description),
      ).toEqual([expect.stringContaining(description)]);
    });

    it("leaves expand-only statements alone", () => {
      expect(
        rollbackFindings(`
          ALTER TABLE "documents" ADD COLUMN "note" text;
          ALTER TABLE "documents" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;
          ALTER TABLE "documents" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY;
          ALTER TABLE "documents" ADD COLUMN "legacy_id" bigserial NOT NULL;
          ALTER TABLE "documents" ALTER COLUMN "title" DROP NOT NULL;
          ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'draft';
          ALTER TABLE "documents" DROP CONSTRAINT "documents_status_check";
          ALTER TABLE "documents" RENAME CONSTRAINT "a" TO "b";
          ALTER TYPE "document_status" ADD VALUE 'archived';
          DROP INDEX CONCURRENTLY "documents_title_idx";
          CREATE INDEX CONCURRENTLY "documents_note_idx" ON "documents" ("note");
          -- DROP TABLE "documents";
          SELECT 'DROP TABLE documents';
        `),
      ).toEqual([]);
    });

    it("ignores contracts on objects this migration creates", () => {
      expect(
        rollbackFindings(`
          CREATE TABLE "drafts" ("id" text PRIMARY KEY, "title" text);
          ALTER TABLE "drafts" ALTER COLUMN "title" SET NOT NULL;
          ALTER TABLE "drafts" ADD CONSTRAINT "drafts_title_check" CHECK ("title" <> '');
          CREATE UNIQUE INDEX "drafts_title_key" ON "drafts" ("title");
          ALTER TABLE "documents"
            ADD COLUMN "draft_id" text,
            ADD CONSTRAINT "documents_draft_fk" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") NOT VALID;
          ALTER TABLE "documents" ADD CONSTRAINT "documents_draft_check" CHECK ("draft_id" IS NULL OR length("draft_id") > 0);
          CREATE UNIQUE INDEX "documents_draft_key" ON "documents" USING btree ("draft_id") WHERE "draft_id" IS NOT NULL;
          CREATE TYPE "draft_status" AS ENUM ('open');
          ALTER TYPE "draft_status" RENAME VALUE 'open' TO 'pending';
        `),
      ).toEqual([]);
    });

    it("still flags a constraint that also reads an existing column", () => {
      expect(
        rollbackFindings(`
          ALTER TABLE "documents" ADD COLUMN "archived_at" timestamptz;
          ALTER TABLE "documents" ADD CONSTRAINT "documents_archive_check"
            CHECK ("archived_at" IS NULL OR "status" = 'archived') NOT VALID;
        `).map((finding) => finding.line),
      ).toEqual([6]);
    });

    it("still flags adding a column NOT NULL without a default", () => {
      expect(
        rollbackFindings(
          `ALTER TABLE "documents" ADD COLUMN "owner_id" text NOT NULL, ADD CONSTRAINT "documents_owner_check" CHECK ("owner_id" <> '');`,
        ).map((finding) => finding.description),
      ).toEqual([expect.stringContaining("public.documents.owner_id")]);
    });

    it("reports the objects an acknowledgement covers", () => {
      const [result] = checkMigrationSources([
        {
          file: PROPERTY_MIGRATION,
          source: `${TIMEOUTS}
            -- stella-migration-safety: reviewed drop-column, rollback-contract - no release since v0.9.0 declares either column
            ALTER TABLE "public"."documents" DROP COLUMN "legacy", DROP COLUMN IF EXISTS "legacy_note";
          `,
        },
      ]);

      expect(result?.guardedFindings).toEqual([]);
      expect(result?.acknowledgementErrors).toEqual([]);
      expect(result?.acknowledgedRollbackTargets).toEqual([
        {
          type: "column",
          schema: "public",
          table: "documents",
          column: "legacy",
        },
        {
          type: "column",
          schema: "public",
          table: "documents",
          column: "legacy_note",
        },
      ]);
    });

    it("rejects an acknowledgement on a statement that contracts nothing", () => {
      expectFinding(
        runChecker(`
          -- stella-migration-safety: reviewed rollback-contract - adds a nullable column only
          ALTER TABLE "documents" ADD COLUMN "note" text;
        `),
        "unused-acknowledgement",
      );
    });

    describe("retired objects", () => {
      const retire = `${TIMEOUTS}
        COMMENT ON COLUMN "documents"."legacy" IS 'stella:retired';
        COMMENT ON TABLE "public"."drafts" IS 'stella:retired - replaced by documents';
      `;
      const contract = `${TIMEOUTS}
        -- stella-migration-safety: reviewed drop-column - retired by the previous release
        ALTER TABLE "documents" DROP COLUMN "legacy";
        -- stella-migration-safety: reviewed drop-object - retired by the previous release
        DROP TABLE "drafts";
      `;
      const findingsFor = (sources: { file: string; source: string }[]) =>
        checkMigrationSources(sources).flatMap(({ file, guardedFindings }) =>
          guardedFindings.map(
            ({ ruleId, line }) => `${file}:${line} ${ruleId}`,
          ),
        );

      it("accepts dropping what an earlier migration retired", () => {
        expect(
          findingsFor([
            {
              file: "apps/api/drizzle/29990101000000_retire/migration.sql",
              source: retire,
            },
            {
              file: "apps/api/drizzle/29990102000000_contract/migration.sql",
              source: contract,
            },
          ]),
        ).toEqual([]);
      });

      it("flags dropping what the same or a later migration retires", () => {
        expect(
          findingsFor([
            {
              file: "apps/api/drizzle/29990102000000_retire/migration.sql",
              source: retire,
            },
            {
              file: "apps/api/drizzle/29990101000000_contract/migration.sql",
              source: contract,
            },
          ]),
        ).toEqual([
          "apps/api/drizzle/29990101000000_contract/migration.sql:6 rollback-contract",
          "apps/api/drizzle/29990101000000_contract/migration.sql:8 rollback-contract",
        ]);
        expect(
          findingsFor([
            {
              file: "apps/api/drizzle/29990101000000_both/migration.sql",
              source: `${retire}${contract.replace(TIMEOUTS, "")}`,
            },
          ]),
        ).toHaveLength(2);
      });

      it("still requires renaming a retired column to be reviewed", () => {
        expect(
          findingsFor([
            {
              file: "apps/api/drizzle/29990101000000_retire/migration.sql",
              source: retire,
            },
            {
              file: "apps/api/drizzle/29990102000000_rename/migration.sql",
              source: `${TIMEOUTS}ALTER TABLE "documents" RENAME COLUMN "legacy" TO "old";`,
            },
          ]),
        ).toEqual([
          "apps/api/drizzle/29990102000000_rename/migration.sql:4 rollback-contract",
          "apps/api/drizzle/29990102000000_rename/migration.sql:4 rename-table-or-column",
        ]);
      });
    });
  });
});
