/**
 * The currencies whose minor-unit exponent is not two, as SQL VALUES rows.
 *
 * A migration cannot call `currencyMinorUnitDigits`, so the answer has to
 * travel as data: `20260905091000_billing_true_minor_units` inlines this
 * output to decide which stored amounts move. That copy is only right while it
 * matches what `Intl` answers, and an ICU update can move a currency's
 * exponent, so `currency-exponents.test.ts` compares the two and fails the
 * build rather than letting a migrated database drift from the running code.
 *
 * Brute-forced over the whole three-letter space rather than
 * `Intl.supportedValuesOf("currency")`: a stored code only has to be well
 * formed to reach `Intl`, and the two lists are not the same.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DEFAULT_MINOR_UNIT_DIGITS = 2;

export const currencyExponentRows = (): string[] => {
  const rows: string[] = [];
  for (const first of LETTERS) {
    for (const second of LETTERS) {
      for (const third of LETTERS) {
        const currency = `${first}${second}${third}`;
        const digits =
          new Intl.NumberFormat("en", {
            style: "currency",
            currency,
          }).resolvedOptions().maximumFractionDigits ??
          DEFAULT_MINOR_UNIT_DIGITS;
        if (digits !== DEFAULT_MINOR_UNIT_DIGITS) {
          rows.push(`  ('${currency}', ${digits})`);
        }
      }
    }
  }
  return rows;
};

/** The rows exactly as the migration file carries them, between its parentheses. */
export const renderCurrencyExponentValues = (): string =>
  currencyExponentRows().join(",\n");
