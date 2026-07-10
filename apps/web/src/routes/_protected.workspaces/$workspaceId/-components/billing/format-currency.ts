import { getFormatter } from "@/i18n/i18n-store";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

// NOTE: cents / 100 assumes a 2-decimal minor unit, which is wrong for
// currencies with a different exponent (KWD has 3, JPY has 0). Fixing that is
// a billing money-model change tracked separately; this module only makes the
// formatting locale-aware.

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
    const isIndianOrg =
      useWorkspaceStore.getState().primaryJurisdictionCountryCode === "IN";

    if (isIndianOrg) {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        minimumFractionDigits,
        ...(maximumFractionDigits === undefined
          ? {}
          : { maximumFractionDigits }),
      }).format(amount);
    }

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
