/** A VAT rate in force from `validFrom` until `validTo` (exclusive), as ISO dates. */
export type VatRatePeriod = {
  validFrom: string;
  validTo: string | null;
  rateBps: number;
};

/**
 * The standard rate in force on a taxable supply date: the highest rate whose
 * period covers the date, or `null` when none does. The API and the invoice
 * composer both use this, so the preview and the issued invoice agree.
 */
export const standardVatRateOn = (
  periods: readonly VatRatePeriod[],
  date: string,
): number | null => {
  const rates = periods
    .filter(
      (period) =>
        period.validFrom <= date &&
        (period.validTo === null || period.validTo > date),
    )
    .map((period) => period.rateBps);
  return rates.length === 0 ? null : Math.max(...rates);
};
