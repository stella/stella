import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

const MIGRATION =
  "../../drizzle/20261027160000_case_law_coverage_summary/migration.sql";
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

test("the summary reader enforces current redistribution without granting table access", async () => {
  await using db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE stella_public_law_reader;
    CREATE ROLE coverage_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO stella, stella_public_law_reader, coverage_test_owner;
    CREATE TABLE case_law_sources (id uuid PRIMARY KEY, descriptor jsonb);
    INSERT INTO case_law_sources VALUES ('${SOURCE_ID}', NULL);
    GRANT SELECT ON case_law_sources TO coverage_test_owner;
  `);
  await db.exec(await Bun.file(new URL(MIGRATION, import.meta.url)).text());
  await db.exec(`
    ALTER TABLE case_law_coverage_summaries OWNER TO coverage_test_owner;
    ALTER FUNCTION public.stella_case_law_coverage_summary() OWNER TO coverage_test_owner;
    SET ROLE coverage_test_owner;
    INSERT INTO case_law_coverage_summaries (key, source_policy, answer, generated_at)
    VALUES ('current', '[]', '{"generatedAt":"2026-10-27T10:00:00.000Z"}', '2026-10-27T10:00:00Z');
    RESET ROLE;
  `);
  const readSummary = async () =>
    (
      await db.query<{ answer: unknown }>(
        "SELECT public.stella_case_law_coverage_summary() AS answer",
      )
    ).rows;

  await db.exec("SET ROLE stella_public_law_reader");
  expect(await readSummary()).toEqual([
    { answer: { generatedAt: "2026-10-27T10:00:00.000Z" } },
  ]);
  expect(
    await rejectionOf(
      db.query("SELECT answer FROM case_law_coverage_summaries"),
    ),
  ).toMatchObject({
    message: expect.stringContaining("permission denied"),
  });
  expect(
    await rejectionOf(
      db.query("UPDATE case_law_coverage_summaries SET answer = '{}'"),
    ),
  ).toMatchObject({
    message: expect.stringContaining("permission denied"),
  });

  await db.exec(`
    RESET ROLE;
    UPDATE case_law_sources SET descriptor = '{"allowsRedistribution":false}';
    SET ROLE stella_public_law_reader;
  `);
  expect(await readSummary()).toEqual([{ answer: null }]);
  await db.exec(`
    RESET ROLE;
    SET ROLE coverage_test_owner;
  `);
  await db.query("UPDATE case_law_coverage_summaries SET source_policy = $1", [
    JSON.stringify([SOURCE_ID]),
  ]);
  await db.exec("RESET ROLE; SET ROLE stella_public_law_reader");
  expect(await readSummary()).toEqual([
    { answer: { generatedAt: "2026-10-27T10:00:00.000Z" } },
  ]);
  await db.exec("RESET ROLE; SET ROLE stella");
  expect(await rejectionOf(readSummary())).toMatchObject({
    message: expect.stringContaining("permission denied"),
  });
});
