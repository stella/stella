import { formatHundredths } from "@stll/money";

import { getFormattingLocale } from "@/i18n/i18n-store";

// The rendering lives in `@stll/money`, which owns the amounts; this module
// binds the reader's formatting locale to it and names the two presets billing
// uses.
//
// NOTE: `formatHundredths` assumes a 2-decimal minor unit, which is wrong for
// currencies with a different exponent (KWD has 3, JPY has 0). Fixing that is
// a billing money-model change tracked separately.

/**
 * Formats a monetary amount given in cents into a localized
 * currency string.
 */
export const formatCurrencyAmount = (cents: number, currency: string): string =>
  formatHundredths({
    amountCents: cents,
    currency,
    locale: getFormattingLocale(),
    fractionDigits: 2,
  });

/**
 * Same as formatCurrencyAmount but with no decimal places.
 * Used in weekly summaries where precision is less important.
 */
export const formatCurrencyCompact = (
  cents: number,
  currency: string,
): string =>
  formatHundredths({
    amountCents: cents,
    currency,
    locale: getFormattingLocale(),
    fractionDigits: 0,
  });

/** Fallback currency when no entries exist. */
export const DEFAULT_CURRENCY = "USD";
