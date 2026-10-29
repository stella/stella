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
    ALTER FUNCTION public.stella_case_law_coverage_summary_v2() OWNER TO coverage_test_owner;
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

const asReader = async <Row>(db: MigratedDatabase, query: string) => {
  await db.exec("RESET ROLE; SET ROLE stella_public_law_reader");
  try {
    return (await db.query<Row>(query)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
};

const readSummary = async (db: MigratedDatabase) =>
  await asReader<{ summary: unknown }>(
    db,
    "SELECT public.stella_case_law_coverage_summary_v2() AS summary",
  );

/** The reader query of releases before the versioned function. */
const readPreviousSummary = async (db: MigratedDatabase) =>
  await asReader<{ answer: unknown }>(
    db,
    "SELECT public.stella_case_law_coverage_summary() AS answer",
  );

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
  for (const reader of [
    "stella_case_law_coverage_summary",
    "stella_case_law_coverage_summary_v2",
  ]) {
    expect(
      await rejectionOf(db.query(`SELECT public.${reader}()`)),
    ).toMatchObject({ message: expect.stringContaining("permission denied") });
  }
});

// Releases still rolling out call the original function and parse its result
// as the bare answer; the versioned reader beside it must not change that.
test("the original summary function answers exactly as before", async () => {
  await using db = await migratedDatabase();
  expect(await readPreviousSummary(db)).toEqual([{ answer: null }]);
  await storeSummary(db, { policy: [] });
  expect(await readPreviousSummary(db)).toEqual([{ answer: ANSWER }]);

  // Any policy difference refuses it, the safe ones included.
  await db.exec(`
    INSERT INTO case_law_sources VALUES
      ('${LATER_SOURCE}', 'later-feed', '${WITHHELD}', '2026-10-28T00:00:00Z');
  `);
  expect(await readPreviousSummary(db)).toEqual([{ answer: null }]);
  await storeSummary(db, { policy: [LATER_SOURCE] });
  expect(await readPreviousSummary(db)).toEqual([{ answer: ANSWER }]);
  await db.exec(
    `UPDATE case_law_sources SET descriptor = '${WITHHELD}' WHERE id = '${COUNTED_SOURCE}'`,
  );
  expect(await readPreviousSummary(db)).toEqual([{ answer: null }]);
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
