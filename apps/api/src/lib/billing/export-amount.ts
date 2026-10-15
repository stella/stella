import { currencyMinorUnitDigits, toMajorUnits } from "@stll/money";

/**
 * A stored amount as the plain decimal string an export file carries.
 *
 * Deliberately not localized: CSV, LEDES 1998B and the PDF text lines are read
 * by billing systems, and a grouping separator or a non-Latin digit would make
 * the field unparseable. The number of decimals is still the currency's own —
 * two for USD, none for JPY, three for KWD — because that is what the stored
 * minor units mean.
 */
export const exportAmountText = (
  amountCents: number,
  currency: string,
): string =>
  toMajorUnits({ amountCents, currency }).toFixed(
    currencyMinorUnitDigits(currency),
  );
