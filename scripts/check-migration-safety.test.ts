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
});
