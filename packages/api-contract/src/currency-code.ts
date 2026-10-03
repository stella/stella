import * as v from "valibot";

/** Uppercase ISO 4217 alphabetic shape; unknown well-formed codes are accepted. */
export const CURRENCY_CODE_LENGTH = 3;

export const CURRENCY_CODE_PATTERN = "^[A-Z]{3}$";

export const currencyCodeSchema = v.pipe(
  v.string(),
  v.length(CURRENCY_CODE_LENGTH),
  v.regex(new RegExp(CURRENCY_CODE_PATTERN, "u")),
);
