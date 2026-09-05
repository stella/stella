/**
 * Print the SQL VALUES rows for every currency whose minor-unit exponent is
 * not two, as `Intl` resolves it.
 *
 * The migration that rescaled billing amounts to true minor units
 * (`20260905090000_billing_true_minor_units`) inlines this output: a migration
 * cannot call `currencyMinorUnitDigits`, so the answer has to travel as data.
 * Rerun this to see whether the runtime's currency table has moved since.
 *
 * Brute-forced over the whole three-letter space rather than
 * `Intl.supportedValuesOf("currency")`, because a stored code only has to be
 * well formed to reach `Intl`, and the two lists are not the same.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DEFAULT_MINOR_UNIT_DIGITS = 2;

const rows: string[] = [];
for (const first of LETTERS) {
  for (const second of LETTERS) {
    for (const third of LETTERS) {
      const currency = `${first}${second}${third}`;
      const digits =
        new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits ?? DEFAULT_MINOR_UNIT_DIGITS;
      if (digits !== DEFAULT_MINOR_UNIT_DIGITS) {
        rows.push(`  ('${currency}', ${digits})`);
      }
    }
  }
}

console.info(`${rows.join(",\n")}\n-- ${rows.length} codes`);
