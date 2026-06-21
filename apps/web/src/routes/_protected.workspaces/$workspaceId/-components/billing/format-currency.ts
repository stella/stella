import { getFormatter } from "@/i18n/i18n-store";

/**
 * Minor-unit exponent for a currency, from ICU data: 2 for USD/EUR/CZK,
 * 3 for KWD, 0 for JPY. Amounts are stored as integer minor units, so this
 * is the power of ten that converts them to the major-unit value.
 */
const currencyFractionDigits = (currency: string): number => {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

/**
 * Formats a monetary amount given in minor units into a localized
 * currency string, honoring the currency's own minor-unit exponent.
 */
export const formatCurrencyAmount = (
  cents: number,
  currency: string,
): string => {
  const digits = currencyFractionDigits(currency);
  const amount = cents / 10 ** digits;
  return formatCurrency({
    amount,
    currency,
    minimumFractionDigits: digits,
    fallback: `${amount.toFixed(digits)} ${currency}`,
  });
};

/**
 * Same as formatCurrencyAmount but with no decimal places.
 * Used in weekly summaries where precision is less important.
 */
export const formatCurrencyCompact = (
  cents: number,
  currency: string,
): string => {
  const amount = cents / 10 ** currencyFractionDigits(currency);
  return formatCurrency({
    amount,
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    fallback: `${Math.round(amount)} ${currency}`,
  });
};

/** Fallback currency when no entries exist. */
export const DEFAULT_CURRENCY = "USD";

const formatCurrency = ({
  amount,
  currency,
  minimumFractionDigits,
  maximumFractionDigits,
  fallback,
}: {
  amount: number;
  currency: string;
  minimumFractionDigits: number;
  maximumFractionDigits?: number;
  fallback: string;
}): string => {
  try {
    return getFormatter().number(amount, {
      style: "currency",
      currency,
      minimumFractionDigits,
      ...(maximumFractionDigits === undefined ? {} : { maximumFractionDigits }),
    });
  } catch {
    // Persisted billing currency codes are only length-validated today.
    return fallback;
  }
};
