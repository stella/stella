import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import { caseLawCourtWeights } from "@/api/db/schema";
import { COURT_WEIGHT_SEED } from "@/api/handlers/case-law/court-weight-seed";
import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260902090000_case_law_court_weight_seed/migration.sql",
);

test("the seed migration applies, brings a stale row to the declared rank, and is idempotent", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const statements = (await Bun.file(MIGRATION).text())
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // A database seeded by an older script holds the key at another rank.
  await db.insert(caseLawCourtWeights).values({
    id: createSafeId<"caseLawCourtWeight">(),
    country: "EU",
    courtPattern: "general court",
    tier: 1,
    tierLabel: "stale",
    weight: 1,
  });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  const first = await db.select().from(caseLawCourtWeights);
  expect(first).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    first.find(
      (row) => row.country === "EU" && row.courtPattern === "general court",
    ),
  ).toMatchObject({ tier: 3, tierLabel: "supreme", weight: 8 });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  const second = await db.select().from(caseLawCourtWeights);
  expect(second).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    second.find((row) => row.country === "EU" && row.tierLabel === "supreme")
      ?.weight,
  ).toBe(8);
  await client.close();
}, 60_000);
