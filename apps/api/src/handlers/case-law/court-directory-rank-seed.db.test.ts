import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { US_COURTS } from "@stll/api-contract/us-courts";

import { caseLawCourtDirectoryRanks } from "@/api/db/schema";
import {
  usCourtDirectoryRankRows,
  usCourtRankSql,
} from "@/api/lib/case-law/court-ranks";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const migrationsDir = nodePath.resolve(import.meta.dir, "../../../drizzle");
const seedMigrations = readdirSync(migrationsDir)
  .filter((directory) =>
    directory.includes("_case_law_court_directory_rank_seed"),
  )
  .toSorted();

const compareRankRows = (
  left: { country: string; courtId: string },
  right: { country: string; courtId: string },
) => {
  const leftKey = `${left.country}:${left.courtId}`;
  const rightKey = `${right.country}:${right.courtId}`;
  return leftKey < rightKey ? -1 : Number(leftKey > rightKey);
};

test("directory rank seed migrations equal every accepted court and repair stale ranks", async () => {
  expect(seedMigrations.length).toBeGreaterThan(0);
  const client = await createTestPglite();
  const db = drizzle({ client });
  const applySeeds = async () => {
    for (const directory of seedMigrations) {
      const path = nodePath.join(migrationsDir, directory, "migration.sql");
      const statements = (await Bun.file(path).text())
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await db.execute(sql.raw(statement));
      }
    }
  };
  const readRanks = async () =>
    (await db.select().from(caseLawCourtDirectoryRanks)).toSorted(
      compareRankRows,
    );
  const declared = usCourtDirectoryRankRows().toSorted(compareRankRows);
  expect(declared).toHaveLength(US_COURTS.length);
  await applySeeds();
  expect(await readRanks()).toEqual(declared);

  const rankScan = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const explained = await tx.execute(sql`
      EXPLAIN (FORMAT JSON)
      SELECT ${usCourtRankSql("d.court_id", "tier")}
      FROM (VALUES ('scotus'::text)) AS d(court_id)
    `);
    return scanOccurrences(explainRoot(explained)).find(
      ({ relation }) => relation === "case_law_court_directory_ranks",
    );
  });
  expect(rankScan?.index).toBe("case_law_court_directory_ranks_pkey");
  expect(rankScan?.indexCond).toContain("court_id");

  await db.execute(sql`
    UPDATE case_law_court_directory_ranks
    SET tier = 1, weight = 1
    WHERE country = 'USA' AND court_id = 'scotus'
  `);
  await applySeeds();
  expect(await readRanks()).toEqual(declared);
  await applySeeds();
  expect(await readRanks()).toEqual(declared);
  await client.close();
}, 60_000);
