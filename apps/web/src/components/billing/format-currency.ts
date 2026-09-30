import { formatMoneyCents } from "@stll/money";

import { getFormattingLocale } from "@/i18n/i18n-store";

// The rendering lives in `@stll/money`, which owns the amounts; this module
// binds the reader's formatting locale to it and names the two presets billing
// uses.

/**
 * A stored minor-unit amount as localized currency text, at the number of
 * decimals the currency itself counts.
 */
export const formatCurrencyAmount = (cents: number, currency: string): string =>
  formatMoneyCents({
    amountCents: cents,
    currency,
    locale: getFormattingLocale(),
  });

/**
 * Same as formatCurrencyAmount but with no decimal places.
 * Used in weekly summaries where precision is less important.
 */
export const formatCurrencyCompact = (
  cents: number,
  currency: string,
): string =>
  formatMoneyCents({
    amountCents: cents,
    currency,
    locale: getFormattingLocale(),
    fractionDigits: 0,
  });

/** Fallback currency when no entries exist. */
export const DEFAULT_CURRENCY = "USD";
