import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const MIGRATION_SQL = readFileSync(
  nodePath.join(
    import.meta.dir,
    "../../drizzle/20261019010000_invoice_party_tax_vat_ids/migration.sql",
  ),
  "utf-8",
);

/** The backfill's own pattern and normalization, so the test checks what deploys. */
const movesToVatId = (value: string) => {
  const pattern = /~ '([^']+)';/u.exec(MIGRATION_SQL)?.[1];
  if (pattern === undefined) {
    throw new Error("Backfill pattern not found in the migration");
  }
  return new RegExp(pattern, "u").test(
    value.replace(/[\s.-]/gu, "").toUpperCase(),
  );
};

describe("party tax/VAT ID backfill (20261019010000)", () => {
  test.each([
    "SK2020123456",
    "CZ12345678",
    "CZ1234567890",
    "DE123456789",
    "ATU12345678",
    "FRXX123456789",
    "NL123456789B01",
    "ESX1234567X",
    "sk 2020 123 456",
  ])("moves the VAT ID %s to vat_id", (value) => {
    expect(movesToVatId(value)).toBe(true);
  });

  test.each([
    "HRB123456",
    "SK12",
    "CZ1234567",
    "2020123456",
    "12345678",
    "HRA 98765",
    "GB123456789",
    "US-EIN-12-3456789",
  ])("keeps %s as a tax ID", (value) => {
    expect(movesToVatId(value)).toBe(false);
  });
});
