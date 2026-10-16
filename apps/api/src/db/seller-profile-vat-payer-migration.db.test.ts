import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

const migration = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

test("the VAT payer backfill keeps every profile with a VAT ID a payer", async () => {
  await using database = new PGlite();
  await database.exec(`
    CREATE TABLE seller_profiles (id text PRIMARY KEY, vat_id varchar(64));
    INSERT INTO seller_profiles VALUES
      ('with-vat-id', 'CZ12345678'),
      ('blank-vat-id', '   '),
      ('no-vat-id', NULL);
  `);
  await database.exec(
    await migration("20261012230000_seller_profile_vat_payer"),
  );
  // The backfill leaves no payer without a VAT ID, so validation succeeds.
  await database.exec(
    await migration("20261012230001_seller_profile_vat_payer_validate"),
  );

  const rows = await database.query<{ id: string; vat_payer: boolean }>(
    "SELECT id, vat_payer FROM seller_profiles ORDER BY id",
  );
  expect(rows.rows).toEqual([
    { id: "blank-vat-id", vat_payer: false },
    { id: "no-vat-id", vat_payer: false },
    { id: "with-vat-id", vat_payer: true },
  ]);
  // A payer without a VAT ID is refused; a VAT ID without payer status is not.
  expect(
    await rejectionOf(
      database.exec(
        "UPDATE seller_profiles SET vat_payer = true WHERE id = 'no-vat-id'",
      ),
    ),
  ).toMatchObject({
    message: expect.stringContaining("seller_profiles_vat_payer_check"),
  });
  await database.exec(
    "UPDATE seller_profiles SET vat_payer = false WHERE id = 'with-vat-id'",
  );
}, 15_000);
