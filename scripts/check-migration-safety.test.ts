import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type CheckerResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const decoder = new TextDecoder();
// Each property run spawns the checker as a subprocess.
const PROPERTY_TEST_TIMEOUT_MS = 60_000;

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
          -- stella-migration-safety: reviewed drop-column, disable-trigger - column unused
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
          -- stella-migration-safety: reviewed drop-object - see
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

    it(
      "never fires on unsafe SQL inside comments, literals, or identifiers",
      () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...UNSAFE_FRAGMENTS),
            fc.constantFrom(...wrappers),
            fc.constantFrom(...wrappers),
            (fragment, first, second) => {
              expectClean(
                runChecker(`${first(fragment)}\n${second(fragment)}`),
              );
            },
          ),
          { numRuns: 30 },
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );

    it(
      "always fires on the same unsafe SQL when it executes",
      () => {
        fc.assert(
          fc.property(
            fc.constantFrom(...UNSAFE_FRAGMENTS.slice(0, 5)),
            fc.constantFrom(...wrappers),
            (fragment, wrapper) => {
              const executable = fragment.startsWith("ON CONFLICT")
                ? `INSERT INTO "documents" ("slug") VALUES ('x') ${fragment};`
                : `${fragment};`;
              const result = runChecker(`${wrapper(fragment)}\n${executable}`);

              expect(result.exitCode).toBe(1);
            },
          ),
          { numRuns: 20 },
        );
      },
      PROPERTY_TEST_TIMEOUT_MS,
    );
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
          `UPDATE ONLY "public" . case_law_decisions SET "indexed_hash" = NULL WHERE "id" = 'x';`,
        ),
        "high-volume-table-dml",
      );
      expectFinding(
        runChecker(`
          INSERT INTO case_law_search_documents ("decision_id")
          SELECT "id" FROM "case_law_decisions" WHERE "indexed_hash" IS NULL;
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
          CREATE INDEX CONCURRENTLY "case_law_citations_note_idx"
            ON "case_law_citations" ("note");
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
});
