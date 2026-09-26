import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import { US_COURTS, US_WRITABLE_COURT_IDS } from "@stll/api-contract/us-courts";

import { caseLawCourtWeights } from "@/api/db/schema";
import {
  COURT_WEIGHT_SEED,
  courtWeightMapFromSeed,
} from "@/api/handlers/case-law/court-weight-seed";
import { createSafeId } from "@/api/lib/branded-types";
import {
  courtTierSqlFromMap,
  courtWeightFromMap,
} from "@/api/lib/case-law/court-weights";
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

const USA_ROWS = COURT_WEIGHT_SEED.filter((row) => row.country === "USA");

const byKey = (
  left: { country: string; courtPattern: string },
  right: { country: string; courtPattern: string },
): number =>
  `${left.country}:${left.courtPattern}` <
  `${right.country}:${right.courtPattern}`
    ? -1
    : 1;

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
  expect(first.filter((row) => row.country === "USA")).toHaveLength(
    USA_ROWS.length,
  );
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
  expect(
    after
      .filter((row) => row.country === "USA")
      .map(({ country, courtPattern, tier, tierLabel, weight }) => ({
        country,
        courtPattern,
        tier,
        tierLabel,
        weight,
      })),
  ).toEqual(USA_ROWS.toSorted(byKey));

  await applyMigration(db, USA_SEED);
  expect(await readRegistry(db)).toEqual(after);
  await client.close();
}, 60_000);

// The rank lookup runs in TypeScript on the corpus-index path and as a SQL
// CASE on the Postgres paths. The United States rows are rendered from the
// directory's writable courts, so the two regex engines are held equal over
// every one of those names, as stored.
test("Postgres ranks every writable United States court as TypeScript does", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const rows = await db.select().from(caseLawCourtWeights);
  const map = courtWeightMapFromSeed();
  expect(rows.filter((row) => row.country === "USA")).toHaveLength(
    USA_ROWS.length,
  );

  const tierSql = sql.raw(
    courtTierSqlFromMap({
      countryColumn: "d.country",
      courtColumn: "d.court",
      map,
    }),
  );
  const names = US_COURTS.filter(({ id }) => US_WRITABLE_COURT_IDS.has(id)).map(
    ({ canonicalName }) => canonicalName,
  );
  expect(names).toHaveLength(US_WRITABLE_COURT_IDS.size);
  const values = sql.join(
    names.map((name) => sql`(${name}, 'USA')`),
    sql`, `,
  );
  const ranked = await db.execute<{ court: string; tier: number }>(
    sql`SELECT d.court, (${tierSql})::int AS tier FROM (VALUES ${values}) AS d(court, country)`,
  );
  const inPostgres = new Map(
    ranked.rows.map(({ court, tier }) => [court, Number(tier)]),
  );
  const differing = names.filter(
    (name) =>
      inPostgres.get(name) !== courtWeightFromMap(map, name, "USA").tier,
  );
  expect(inPostgres.size).toBe(names.length);
  expect(differing).toEqual([]);
  // Ranked by a seeded row, not by the default every unranked court gets.
  expect(
    names.filter((name) =>
      rows.some(
        (row) =>
          row.country === "USA" &&
          new RegExp(row.courtPattern, "iu").test(name),
      ),
    ),
  ).toEqual(names);
  await client.close();
}, 60_000);
