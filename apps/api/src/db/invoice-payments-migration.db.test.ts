import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { expect, test } from "bun:test";

const MIGRATION = "20261027210000_invoice_payments";

const migrationSql = async () =>
  await Bun.file(
    new URL(`../../drizzle/${MIGRATION}/migration.sql`, import.meta.url),
  ).text();

const ORGANIZATION = "org-payments";
const SENT = "01a17ebc-0000-7000-8000-000000000001";
const PAID = "01a17ebc-0000-7000-8000-000000000002";
const CREDIT = "01a17ebc-0000-7000-8000-000000000003";

// The invoice columns the migration and payments touch, as deployed before it.
const seedDatabase = async (database: PGlite) => {
  await database.exec(`
    DO $$ BEGIN CREATE ROLE stella; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE invoices (id uuid PRIMARY KEY, organization_id varchar(128) NOT NULL
      REFERENCES organization (id) ON DELETE CASCADE, status text NOT NULL,
      total_amount bigint NOT NULL, paid_at timestamptz);
    INSERT INTO organization VALUES ('${ORGANIZATION}');
    INSERT INTO invoices VALUES
      ('${SENT}', '${ORGANIZATION}', 'sent', 12100, NULL),
      ('${PAID}', '${ORGANIZATION}', 'paid', 5000, '2026-10-01T09:30:00Z'),
      ('${CREDIT}', '${ORGANIZATION}', 'finalized', -2500, NULL);
  `);
};

const readInvoices = async (database: PGlite) =>
  (
    await database.query(
      "SELECT id, organization_id, status, total_amount, paid_at FROM invoices ORDER BY id",
    )
  ).rows;

test("the payments migration is additive: existing invoices and totals are unchanged", async () => {
  await using database = new PGlite();
  await seedDatabase(database);
  const before = await readInvoices(database);
  expect(before).toHaveLength(3);

  await database.exec(`BEGIN; ${await migrationSql()} COMMIT;`);

  expect(await readInvoices(database)).toEqual(before);
  // The new sent marker is empty on every existing invoice.
  expect(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM invoices WHERE sent_at IS NOT NULL",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (await database.query("SELECT count(*)::int AS n FROM invoice_payments"))
      .rows,
  ).toEqual([{ n: 0 }]);
});

test("payments are checked, go with their invoice and with their organization", async () => {
  await using database = new PGlite();
  await seedDatabase(database);
  await database.exec(`BEGIN; ${await migrationSql()} COMMIT;`);
  const insertPayment = async (id: string, invoiceId: string) =>
    await database.exec(`
      INSERT INTO invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, recorded_by)
      VALUES ('${id}', '${ORGANIZATION}', '${invoiceId}', 2100, '2026-10-20', 'bank_transfer', 'user-1');
    `);
  await insertPayment("01a17ebc-0000-7000-8000-0000000000a1", SENT);
  await insertPayment("01a17ebc-0000-7000-8000-0000000000a2", PAID);

  // A deliberate removal of an invoice (review reset, test cleanup) takes
  // its payments in the same statement.
  await database.exec(`DELETE FROM invoices WHERE id = '${SENT}'`);
  expect(
    (
      await database.query<{ invoice_id: string }>(
        "SELECT invoice_id FROM invoice_payments",
      )
    ).rows,
  ).toEqual([{ invoice_id: PAID }]);

  for (const invalid of [
    // Not positive.
    `(gen_random_uuid(), '${ORGANIZATION}', '${PAID}', 0, '2026-10-20', 'cash', 'user-1', NULL, NULL)`,
    // Unknown method.
    `(gen_random_uuid(), '${ORGANIZATION}', '${PAID}', 10, '2026-10-20', 'cheque', 'user-1', NULL, NULL)`,
    // Voided without who voided it.
    `(gen_random_uuid(), '${ORGANIZATION}', '${PAID}', 10, '2026-10-20', 'cash', 'user-1', now(), NULL)`,
    // An invoice that does not exist.
    `(gen_random_uuid(), '${ORGANIZATION}', gen_random_uuid(), 10, '2026-10-20', 'cash', 'user-1', NULL, NULL)`,
  ]) {
    const insert = await Result.tryPromise(
      async () =>
        await database.exec(
          `INSERT INTO invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, recorded_by, voided_at, voided_by) VALUES ${invalid}`,
        ),
    );
    expect(insert.isErr(), invalid).toBe(true);
  }

  await database.exec(`DELETE FROM organization WHERE id = '${ORGANIZATION}'`);
  expect(await readInvoices(database)).toEqual([]);
  expect(
    (await database.query("SELECT count(*)::int AS n FROM invoice_payments"))
      .rows,
  ).toEqual([{ n: 0 }]);
});
