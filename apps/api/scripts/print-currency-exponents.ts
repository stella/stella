/**
 * Print the SQL VALUES rows for every currency whose minor-unit exponent is
 * not two, as `Intl` resolves it.
 *
 * The migration that rescaled billing amounts to true minor units
 * (`20260905090000_billing_true_minor_units`) inlines this output. Run this to
 * regenerate that block; `apps/api/src/db/currency-exponents.test.ts` fails the
 * build when the two stop matching, so the copy cannot drift on its own.
 */

import {
  currencyExponentRows,
  renderCurrencyExponentValues,
} from "@/api/db/currency-exponents";

console.info(
  `${renderCurrencyExponentValues()}\n-- ${currencyExponentRows().length} codes`,
);
