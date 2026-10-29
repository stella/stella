import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

const MIGRATIONS = [
  "../../drizzle/20261027160000_case_law_coverage_summary/migration.sql",
  "../../drizzle/20261029141500_case_law_coverage_snapshot_freshness/migration.sql",
] as const;
const COUNTED_SOURCE = "00000000-0000-4000-8000-000000000001";
const LATER_SOURCE = "00000000-0000-4000-8000-000000000002";
const GENERATED_AT = "2026-10-27T10:00:00.000Z";
const ANSWER = {
  generatedAt: GENERATED_AT,
  countries: [{ country: "CZE", sources: [{ adapterKey: "counted-feed" }] }],
};
const WITHHELD = '{"allowsRedistribution":false}';

const migratedDatabase = async () => {
  const db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE stella_public_law_reader;
    CREATE ROLE coverage_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO stella, stella_public_law_reader, coverage_test_owner;
    CREATE TABLE case_law_sources (
      id uuid PRIMARY KEY,
      adapter_key varchar(64) NOT NULL UNIQUE,
      descriptor jsonb,
      created_at timestamptz NOT NULL
    );
    INSERT INTO case_law_sources VALUES
      ('${COUNTED_SOURCE}', 'counted-feed', NULL, '2026-10-01T00:00:00Z');
    GRANT SELECT ON case_law_sources TO coverage_test_owner;
  `);
  for (const migration of MIGRATIONS) {
    await db.exec(await Bun.file(new URL(migration, import.meta.url)).text());
  }
  await db.exec(`
    ALTER TABLE case_law_coverage_summaries OWNER TO coverage_test_owner;
    ALTER FUNCTION public.stella_case_law_coverage_summary() OWNER TO coverage_test_owner;
  `);
  return db;
};

type MigratedDatabase = Awaited<ReturnType<typeof migratedDatabase>>;

const storeSummary = async (
  db: MigratedDatabase,
  { policy, answer = ANSWER }: { policy: readonly string[]; answer?: object },
) => {
  await db.exec("RESET ROLE; SET ROLE coverage_test_owner");
  await db.query(
    `INSERT INTO case_law_coverage_summaries (key, source_policy, answer, generated_at)
     VALUES ('current', $1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET source_policy = EXCLUDED.source_policy,
       answer = EXCLUDED.answer, generated_at = EXCLUDED.generated_at`,
    [JSON.stringify(policy), JSON.stringify(answer), GENERATED_AT],
  );
  await db.exec("RESET ROLE");
};

const readSummary = async (db: MigratedDatabase) => {
  await db.exec("RESET ROLE; SET ROLE stella_public_law_reader");
  try {
    return (
      await db.query<{ summary: unknown }>(
        "SELECT public.stella_case_law_coverage_summary() AS summary",
      )
    ).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
};

test("the summary reader serves only through the function, never the table", async () => {
  await using db = await migratedDatabase();
  expect(await readSummary(db)).toEqual([{ summary: null }]);
  await storeSummary(db, { policy: [] });
  expect(await readSummary(db)).toEqual([
    { summary: { answer: ANSWER, policyCurrent: true } },
  ]);
  await db.exec("SET ROLE stella_public_law_reader");
  expect(
    await rejectionOf(
      db.query("SELECT answer FROM case_law_coverage_summaries"),
    ),
  ).toMatchObject({ message: expect.stringContaining("permission denied") });
  expect(
    await rejectionOf(
      db.query("UPDATE case_law_coverage_summaries SET answer = '{}'"),
    ),
  ).toMatchObject({ message: expect.stringContaining("permission denied") });
  await db.exec("RESET ROLE; SET ROLE stella");
  expect(
    await rejectionOf(
      db.query("SELECT public.stella_case_law_coverage_summary()"),
    ),
  ).toMatchObject({ message: expect.stringContaining("permission denied") });
});

test("a source withheld after the snapshot was computed leaves the snapshot served", async () => {
  await using db = await migratedDatabase();
  await storeSummary(db, { policy: [] });
  await db.exec(`
    INSERT INTO case_law_sources VALUES
      ('${LATER_SOURCE}', 'later-feed', '${WITHHELD}', '2026-10-28T00:00:00Z');
  `);
  expect(await readSummary(db)).toEqual([
    { summary: { answer: ANSWER, policyCurrent: false } },
  ]);

  // A source the answer lists was counted whatever its creation time says.
  await storeSummary(db, {
    policy: [],
    answer: {
      ...ANSWER,
      countries: [{ country: "CZE", sources: [{ adapterKey: "later-feed" }] }],
    },
  });
  expect(await readSummary(db)).toEqual([{ summary: null }]);
});

test("a source the snapshot counted that is no longer redistributable refuses it", async () => {
  await using db = await migratedDatabase();
  await storeSummary(db, { policy: [] });
  await db.exec(
    `UPDATE case_law_sources SET descriptor = '${WITHHELD}' WHERE id = '${COUNTED_SOURCE}'`,
  );
  expect(await readSummary(db)).toEqual([{ summary: null }]);

  // A source that was already withheld when the answer was computed is
  // outside its figures, so the answer stands under the same policy.
  await storeSummary(db, { policy: [COUNTED_SOURCE] });
  expect(await readSummary(db)).toEqual([
    { summary: { answer: ANSWER, policyCurrent: true } },
  ]);

  // Redistribution granted again: the answer still excludes the source,
  // which is safe to serve but no longer the current policy.
  await db.exec(
    `UPDATE case_law_sources SET descriptor = NULL WHERE id = '${COUNTED_SOURCE}'`,
  );
  expect(await readSummary(db)).toEqual([
    { summary: { answer: ANSWER, policyCurrent: false } },
  ]);
});
