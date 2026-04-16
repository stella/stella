/**
 * Formats a monetary amount given in cents into a localized
 * currency string.
 */
export const formatCurrencyAmount = (
  cents: number,
  currency: string,
): string => {
  const amount = cents / 100;
  return formatCurrency({
    amount,
    currency,
    minimumFractionDigits: 2,
    fallback: `${amount.toFixed(2)} ${currency}`,
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
  const amount = cents / 100;
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
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(amount);
  } catch {
    // Persisted billing currency codes are only length-validated today.
    return fallback;
  }
};
