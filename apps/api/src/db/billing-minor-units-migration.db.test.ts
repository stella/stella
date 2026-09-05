import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * The rescale to true minor units, applied to a database in its pre-migration
 * shape.
 *
 * The shared test database boots the CURRENT schema, so it cannot hold a row
 * written under the old hundredths rule. This suite therefore builds the four
 * billing tables as they were and runs the migration file itself, which is the
 * only way to prove what the deployment will do to existing rows.
 *
 * Only the columns the migration reads are declared; the rest of each table is
 * irrelevant to the arithmetic and would only couple this test to unrelated
 * schema churn.
 */

const MIGRATION_SQL = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260905090000_billing_true_minor_units/migration.sql",
);

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE invoices (
  id text PRIMARY KEY,
  total_amount integer NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL
);
CREATE TABLE time_entries (
  id text PRIMARY KEY,
  invoice_id text REFERENCES invoices(id),
  billed_minutes integer NOT NULL,
  rate_at_entry integer NOT NULL,
  currency varchar(3) NOT NULL
);
CREATE TABLE rate_tables (
  id text PRIMARY KEY,
  currency varchar(3) NOT NULL
);
CREATE TABLE rate_entries (
  id text PRIMARY KEY,
  rate_table_id text NOT NULL REFERENCES rate_tables(id),
  hourly_rate integer NOT NULL
);
CREATE TABLE expenses (
  id text PRIMARY KEY,
  invoice_id text REFERENCES invoices(id),
  amount integer NOT NULL,
  markup integer NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL,
  CONSTRAINT expenses_amount_positive_check CHECK (amount > 0)
);
`;

// Rows as the hundredths rule wrote them: a major-unit amount times 100,
// whatever the currency's own exponent is.
const PRE_MIGRATION_ROWS = `
INSERT INTO invoices VALUES
  ('inv_jpy', 100, 'JPY'),
  ('inv_usd', 10000, 'USD'),
  ('inv_empty', 0, 'JPY');
INSERT INTO time_entries VALUES
  ('te_jpy_1', 'inv_jpy', 60, 50, 'JPY'),
  ('te_jpy_2', 'inv_jpy', 60, 50, 'JPY'),
  ('te_usd', 'inv_usd', 60, 10000, 'USD'),
  ('te_kwd', NULL, 60, 1250, 'KWD');
INSERT INTO rate_tables VALUES ('rt_jpy', 'JPY'), ('rt_usd', 'USD');
INSERT INTO rate_entries VALUES
  ('re_jpy', 'rt_jpy', 150000),
  ('re_usd', 'rt_usd', 10000);
INSERT INTO expenses VALUES
  ('ex_jpy', NULL, 150000, 0, 'JPY'),
  ('ex_jpy_tiny', NULL, 30, 0, 'JPY'),
  ('ex_usd', NULL, 500, 0, 'USD');
`;

let database: PGlite;

const scalar = async (query: string): Promise<number> => {
  const result = await database.query<{ value: number | string }>(query);
  return Number(result.rows.at(0)?.value);
};

beforeAll(async () => {
  database = new PGlite();
  await database.exec(PRE_MIGRATION_SCHEMA);
  await database.exec(PRE_MIGRATION_ROWS);

  const statements = readFileSync(MIGRATION_SQL, "utf-8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim().length > 0);
  for (const statement of statements) {
    // Sequential on purpose: a migration's statements are ordered, and the
    // rescales have to land before the invoice recompute reads them.
    // eslint-disable-next-line no-await-in-loop -- migration statements are ordered
    await database.exec(statement);
  }
}, 60_000);

afterAll(async () => {
  await database.close();
});

test("a zero-exponent currency divides by a hundred and a three-exponent one multiplies by ten", async () => {
  expect(
    await scalar(
      "SELECT rate_at_entry AS value FROM time_entries WHERE id = 'te_jpy_1'",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT rate_at_entry AS value FROM time_entries WHERE id = 'te_kwd'",
    ),
  ).toBe(12_500);
  expect(
    await scalar(
      "SELECT hourly_rate AS value FROM rate_entries WHERE id = 're_jpy'",
    ),
  ).toBe(1500);
  expect(
    await scalar("SELECT amount AS value FROM expenses WHERE id = 'ex_jpy'"),
  ).toBe(1500);
});

test("a two-exponent currency is left exactly as it was", async () => {
  expect(
    await scalar(
      "SELECT rate_at_entry AS value FROM time_entries WHERE id = 'te_usd'",
    ),
  ).toBe(10_000);
  expect(
    await scalar(
      "SELECT hourly_rate AS value FROM rate_entries WHERE id = 're_usd'",
    ),
  ).toBe(10_000);
  expect(
    await scalar("SELECT amount AS value FROM expenses WHERE id = 'ex_usd'"),
  ).toBe(500);
  expect(
    await scalar(
      "SELECT total_amount AS value FROM invoices WHERE id = 'inv_usd'",
    ),
  ).toBe(10_000);
});

test("an amount the currency cannot express is floored at the smallest it can", async () => {
  // 30 hundredths of a yen rounds to zero, which the positivity check forbids.
  expect(
    await scalar(
      "SELECT amount AS value FROM expenses WHERE id = 'ex_jpy_tiny'",
    ),
  ).toBe(1);
});

test("the invoice total is recomputed from its migrated lines, not rescaled", async () => {
  // Two one-hour lines at a stored rate of 50 prorated to 50 each, so the
  // stored total was 100. Rescaling that total gives 1; each line rescales to
  // 1 and prorates to 1, so the invoice is 2.
  expect(
    await scalar(
      "SELECT total_amount AS value FROM invoices WHERE id = 'inv_jpy'",
    ),
  ).toBe(2);
});

test("an invoice with no attached lines recomputes to zero", async () => {
  expect(
    await scalar(
      "SELECT total_amount AS value FROM invoices WHERE id = 'inv_empty'",
    ),
  ).toBe(0);
});
