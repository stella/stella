import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { renderCurrencyExponentValues } from "@/api/db/currency-exponents";

/**
 * The migration carries the exponent table as data because SQL cannot call the
 * helper. Two copies of one fact drift silently: an ICU update that moves a
 * currency's exponent would leave the running code scaling one way and the
 * already-migrated rows stored the other. This is the check that makes that
 * disagreement a build failure instead.
 */

const MIGRATION_SQL = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260905090000_billing_true_minor_units/migration.sql",
);

// Every `(VALUES … ) AS exponent(currency, digits)` block in the file.
const VALUES_BLOCK =
  /\(VALUES\n(?<rows>[\s\S]*?)\n {7}\) AS exponent\(currency, digits\)/gu;

const migrationBlocks = (): string[] =>
  [...readFileSync(MIGRATION_SQL, "utf-8").matchAll(VALUES_BLOCK)].map(
    (match) => match.groups?.["rows"] ?? "",
  );

test("the migration's exponent table is what Intl answers today", () => {
  const blocks = migrationBlocks();

  // One statement per rescaled table plus the invoice recompute; a block that
  // stops matching this shape would silently drop out of the comparison.
  expect(blocks).toHaveLength(4);

  const expected = renderCurrencyExponentValues();
  for (const block of blocks) {
    expect(block).toBe(expected);
  }
});
