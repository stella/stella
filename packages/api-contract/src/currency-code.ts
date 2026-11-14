import * as v from "valibot";

/** Uppercase ISO 4217 alphabetic shape; unknown well-formed codes are accepted. */
export const CURRENCY_CODE_LENGTH = 3;

export const CURRENCY_CODE_PATTERN = "^[A-Z]{3}$";

/**
 * ISO 4217 alphabetic code, upper case, for a column that stores money.
 *
 * Three LETTERS, not three characters: a stored "A1C" satisfies a length check
 * and then makes `Intl.NumberFormat` throw the moment something formats it. An
 * unknown-but-well-formed code ("ZZZ") is accepted, because `Intl` accepts it.
 *
 * Case is part of the contract here, unlike the workspace field-currency schema
 * in the API's `db/schema-validators.ts`, which still admits either case. `Intl` resolves
 * "jpy" and "JPY" alike, so a mixed-case column would look fine and still be
 * two currencies to anything that groups or joins on the code — including the
 * migration that rescaled these amounts to true minor units, and `MoneyTotals`,
 * which buckets by the raw string.
 */
export const currencyCodeSchema = v.pipe(
  v.string(),
  v.length(CURRENCY_CODE_LENGTH),
  v.regex(new RegExp(CURRENCY_CODE_PATTERN, "u")),
);
