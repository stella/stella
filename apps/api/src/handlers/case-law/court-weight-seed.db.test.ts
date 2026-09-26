import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import { caseLawCourtWeights } from "@/api/db/schema";
import { COURT_WEIGHT_SEED } from "@/api/handlers/case-law/court-weight-seed";
import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const migrationPath = (directory: string) =>
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle",
    directory,
    "migration.sql",
  );

const FULL_SEED = migrationPath(
  "20260918210100_case_law_court_weight_seed_hun",
);
const USA_SEED = migrationPath("20260926100100_case_law_court_weight_seed_usa");

type TestDb = ReturnType<typeof drizzle>;

const applyMigration = async (db: TestDb, path: string): Promise<void> => {
  const statements = (await Bun.file(path).text())
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Every row, keyed and ordered so two reads compare field by field. */
const readRegistry = async (db: TestDb) =>
  (await db.select().from(caseLawCourtWeights))
    .map(({ country, courtPattern, id, tier, tierLabel, weight }) => ({
      country,
      courtPattern,
      id,
      tier,
      tierLabel,
      weight,
    }))
    .toSorted((left, right) =>
      `${left.country}:${left.courtPattern}` <
      `${right.country}:${right.courtPattern}`
        ? -1
        : 1,
    );

test("the seed migrations apply, reconcile stale rows, and are idempotent", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  // A database seeded by an older script holds the key at another rank, and
  // carries a pattern the declaration has since widened.
  await db.insert(caseLawCourtWeights).values([
    {
      id: createSafeId<"caseLawCourtWeight">(),
      country: "EU",
      courtPattern: "general court",
      tier: 1,
      tierLabel: "stale",
      weight: 1,
    },
    {
      id: createSafeId<"caseLawCourtWeight">(),
      country: "POL",
      courtPattern: "sąd apelacyjny",
      tier: 2,
      tierLabel: "appeal",
      weight: 5,
    },
  ]);
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const first = await db.select().from(caseLawCourtWeights);
  expect(first).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    first.find(
      (row) => row.country === "EU" && row.courtPattern === "general court",
    ),
  ).toMatchObject({ tier: 3, tierLabel: "supreme", weight: 8 });
  expect(
    first.filter(
      (row) =>
        row.country === "POL" && /sąd apelacyjny/u.test(row.courtPattern),
    ),
  ).toMatchObject([
    {
      courtPattern: "sąd apelacyjny|wojewódzki sąd administracyjny",
      tierLabel: "appeal",
      weight: 5,
    },
  ]);
  expect(first.filter((row) => row.country === "USA")).toMatchObject([
    {
      courtPattern: "^supreme court of the united states$",
      tier: 3,
      tierLabel: "supreme",
      weight: 8,
    },
  ]);
  // Together the two leave exactly the declaration.
  expect(
    first
      .map(({ country, courtPattern, tier, tierLabel, weight }) => ({
        country,
        courtPattern,
        tier,
        tierLabel,
        weight,
      }))
      .toSorted((left, right) =>
        `${left.country}:${left.courtPattern}` <
        `${right.country}:${right.courtPattern}`
          ? -1
          : 1,
      ),
  ).toEqual(
    COURT_WEIGHT_SEED.toSorted((left, right) =>
      `${left.country}:${left.courtPattern}` <
      `${right.country}:${right.courtPattern}`
        ? -1
        : 1,
    ),
  );
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const second = await db.select().from(caseLawCourtWeights);
  expect(second).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    second.find((row) => row.country === "EU" && row.tierLabel === "supreme")
      ?.weight,
  ).toBe(8);
  await client.close();
}, 60_000);

test("the USA seed writes no row of another jurisdiction", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await applyMigration(db, FULL_SEED);
  // Rows the USA seed must leave exactly as it finds them: one at a rank the
  // declaration does not hold, and one pattern it does not carry, both of the
  // kind the full seed would reconcile.
  await db.execute(
    sql`UPDATE case_law_court_weights SET tier = 1, tier_label = 'stale', weight = 1 WHERE country = 'EU' AND court_pattern = 'general court'`,
  );
  await db.insert(caseLawCourtWeights).values({
    id: createSafeId<"caseLawCourtWeight">(),
    country: "CZE",
    courtPattern: "okresní soud",
    tier: 1,
    tierLabel: "district",
    weight: 2,
  });
  const before = await readRegistry(db);
  expect(before.some((row) => row.country === "USA")).toBe(false);

  await applyMigration(db, USA_SEED);
  const after = await readRegistry(db);
  expect(after.filter((row) => row.country !== "USA")).toEqual(before);
  expect(after.filter((row) => row.country === "USA")).toMatchObject([
    {
      courtPattern: "^supreme court of the united states$",
      tier: 3,
      tierLabel: "supreme",
      weight: 8,
    },
  ]);

  await applyMigration(db, USA_SEED);
  expect(await readRegistry(db)).toEqual(after);
  await client.close();
}, 60_000);
