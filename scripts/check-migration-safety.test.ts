import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CheckerResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const decoder = new TextDecoder();

const runChecker = (sql: string): CheckerResult => {
  const directory = mkdtempSync(join(tmpdir(), "stella-migration-safety-"));
  const file = join(directory, "migration.sql");

  writeFileSync(file, sql);

  try {
    const result = Bun.spawnSync([
      "bun",
      "scripts/check-migration-safety.ts",
      file,
    ]);

    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("check-migration-safety", () => {
  it("rejects column-target ON CONFLICT clauses", () => {
    const result = runChecker(`
      INSERT INTO "mcp_connectors" ("slug")
      VALUES ('salvia')
      ON CONFLICT ("slug") DO NOTHING;
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("on-conflict-column-target");
    expect(result.stderr).toContain("WHERE NOT EXISTS");
  });

  it("allows named-constraint ON CONFLICT clauses", () => {
    const result = runChecker(`
      INSERT INTO "practice_areas" ("slug")
      VALUES ('corporate')
      ON CONFLICT ON CONSTRAINT "practice_areas_slug_unique" DO NOTHING;
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows partial-index idempotence via WHERE NOT EXISTS", () => {
    const result = runChecker(`
      INSERT INTO "mcp_connectors" ("slug", "organization_id")
      SELECT 'salvia', NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM "mcp_connectors"
        WHERE "slug" = 'salvia'
          AND "organization_id" IS NULL
      );
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("ignores unsafe-looking SQL inside string literals", () => {
    const result = runChecker(`
      SELECT 'ON CONFLICT ("slug") DO NOTHING';
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("flags a full-table UPDATE with no WHERE clause", () => {
    const result = runChecker(`
      UPDATE "documents" SET "status" = 'archived';
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unbounded-update");
  });

  it("allows an UPDATE bounded by a WHERE clause", () => {
    const result = runChecker(`
      UPDATE "documents" SET "status" = 'archived' WHERE "id" = 2;
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows an INSERT ... ON CONFLICT DO UPDATE SET upsert", () => {
    // Named-constraint arbiter so this exercises only the unbounded-update
    // exclusion, not the separate on-conflict-column-target invariant.
    const result = runChecker(`
      INSERT INTO "documents" ("id", "status") VALUES (1, 'archived')
      ON CONFLICT ON CONSTRAINT "documents_pkey" DO UPDATE SET "status" = EXCLUDED."status";
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("flags a CTE upsert wrapping an unbounded outer UPDATE", () => {
    // The inner INSERT ... ON CONFLICT lives at paren depth > 0, so the outer
    // command is the full-table UPDATE: the upsert must not exempt it.
    const result = runChecker(`
      WITH "seed" AS (
        INSERT INTO "documents" ("id", "status") VALUES (1, 'archived')
        ON CONFLICT ON CONSTRAINT "documents_pkey" DO NOTHING RETURNING "id"
      )
      UPDATE "documents" SET "status" = 'archived';
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unbounded-update");
  });

  it("allows a CREATE POLICY ... FOR UPDATE clause", () => {
    // The outer command is CREATE, not UPDATE: `FOR UPDATE` is a policy clause
    // and rewrites no table data, so it must not trip the unbounded-update rule.
    const result = runChecker(`
      CREATE POLICY "documents_update" ON "documents"
      FOR UPDATE USING ("organization_id" = current_setting('app.org')::uuid);
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows a CREATE TRIGGER ... BEFORE UPDATE definition", () => {
    const result = runChecker(`
      CREATE TRIGGER "documents_touch" BEFORE UPDATE ON "documents"
      FOR EACH ROW EXECUTE FUNCTION "touch_updated_at"();
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("flags a full-table UPDATE whose only WHERE is in a SET subquery", () => {
    const result = runChecker(`
      UPDATE "documents"
      SET "workspace_id" = (
        SELECT "id" FROM "workspaces" WHERE "workspaces"."slug" = 'x'
      );
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unbounded-update");
  });

  it("allows a FROM-join UPDATE bounded by a top-level WHERE", () => {
    const result = runChecker(`
      UPDATE "documents" AS d
      SET "workspace_id" = w."id"
      FROM "workspaces" AS w
      WHERE d."workspace_slug" = w."slug";
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("clears an unbounded UPDATE with a bulk-backfill acknowledgement", () => {
    const result = runChecker(`
      -- stella-migration-safety: reviewed bulk-backfill - table has under ten rows
      UPDATE "documents" SET "status" = 'archived';
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("does not clear an unbounded UPDATE with a destructive-change acknowledgement", () => {
    const result = runChecker(`
      -- stella-migration-safety: reviewed destructive-change - rollback handled separately
      UPDATE "documents" SET "status" = 'archived';
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unbounded-update");
  });

  it("flags a recursive CTE", () => {
    const result = runChecker(`
      WITH RECURSIVE "ancestors" AS (
        SELECT "id", "parent_id" FROM "matters" WHERE "id" = 1
        UNION ALL
        SELECT "m"."id", "m"."parent_id"
        FROM "matters" "m"
        JOIN "ancestors" "a" ON "m"."id" = "a"."parent_id"
      )
      UPDATE "matters" SET "depth" = 0 WHERE "id" IN (SELECT "id" FROM "ancestors");
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("recursive-cte");
  });

  it("does not clear a destructive change with a bulk-backfill acknowledgement", () => {
    const result = runChecker(`
      -- stella-migration-safety: reviewed bulk-backfill - small table backfill
      DROP TABLE "documents";
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("drop-object");
  });

  it("clears a destructive change with a destructive-change acknowledgement", () => {
    const result = runChecker(`
      -- stella-migration-safety: reviewed destructive-change - replaced by documents_v2, rollback restores from backup
      DROP TABLE "documents";
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
