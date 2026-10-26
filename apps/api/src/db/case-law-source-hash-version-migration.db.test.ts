import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261020013635_case_law_source_hash_version/migration.sql",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.execute(sql.raw('DROP VIEW "case_law_unredacted_decisions"'));
    await db.execute(sql.raw('DROP VIEW "case_law_published_decisions"'));
    await db.execute(
      sql.raw(
        'ALTER TABLE "case_law_decisions" DROP COLUMN "source_hash_version"',
      ),
    );
    await db.execute(
      sql.raw(`
      CREATE VIEW "case_law_published_decisions" AS
      SELECT * FROM "case_law_decisions"
      WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true')
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE VIEW "case_law_unredacted_decisions" AS
      SELECT * FROM "case_law_decisions"
      WHERE redacted_at IS NULL
    `),
    );

    const statements = readFileSync(MIGRATION_PATH, "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test.each([
  ["published", "case_law_published_decisions"],
  ["unredacted", "case_law_unredacted_decisions"],
])(
  "the migrated %s decision view exposes source_hash_version",
  async (_, view) => {
    const result = await db.execute(
      sql.raw(`SELECT "source_hash_version" FROM "${view}" LIMIT 0`),
    );
    expect(result.rows).toEqual([]);
  },
);
