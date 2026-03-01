/**
 * Formats a monetary amount given in cents into a localized
 * currency string.
 */
export const formatCurrencyAmount = (
  cents: number,
  currency: string,
): string => {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/**
 * Same as formatCurrencyAmount but with no decimal places.
 * Used in weekly summaries where precision is less important.
 */
export const formatCurrencyCompact = (
  cents: number,
  currency: string,
): string => {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
};

/** Fallback currency when no entries exist. */
export const DEFAULT_CURRENCY = "USD";
