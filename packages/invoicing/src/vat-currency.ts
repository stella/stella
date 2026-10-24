import { panic } from "better-result";

import { cents, type CentsAmount } from "@stll/money";

import type { InvoiceCountry } from "./profiles/country-profiles";
import type { VatBreakdownLine } from "./types";

export type VatRateCountry = Extract<InvoiceCountry, "CZ" | "SK"> | "PL";

type TaxPointInput = {
  country: VatRateCountry;
  invoiceDate: string;
  taxableSupplyDate: string | null;
};

export const vatTaxPointDate = ({
  country,
  invoiceDate,
  taxableSupplyDate,
}: TaxPointInput): string => {
  if (country === "CZ") {
    // CZ zákon 235/2004 Sb. § 21 odst. 3: services use the earlier supply/document issue date.
    return taxableSupplyDate === null || invoiceDate < taxableSupplyDate
      ? invoiceDate
      : taxableSupplyDate;
  }
  if (country === "SK") {
    // SK zákon 222/2004 Z. z. § 19 ods. 2: the service supply date is the tax point.
    return taxableSupplyDate ?? invoiceDate;
  }
  // PL ustawa o VAT art. 19a ust. 1: tax arises when the supply is made.
  return taxableSupplyDate ?? invoiceDate;
};

type Decimal = { coefficient: bigint; scale: number };

const decimal = (value: string): Decimal => {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) {
    panic("Rate must be a positive decimal string");
  }
  const whole = match.at(1);
  if (whole === undefined) {
    panic("A matched decimal must contain its whole-number part");
  }
  const fraction = match.at(2) ?? "";
  const coefficient = BigInt(`${whole}${fraction}`);
  if (coefficient <= 0n) {
    panic("Rate must be positive");
  }
  return { coefficient, scale: fraction.length };
};

const powerOfTen = (places: number) => 10n ** BigInt(places);

const divideHalfUp = (numerator: bigint, denominator: bigint) =>
  (numerator * 2n + denominator) / (denominator * 2n);

/** Converts a source quote to home-currency units per one invoice-currency unit. */
export const normalizeVatExchangeRate = (input: {
  quote: string;
  foreignUnits: number;
  direction: "home_per_foreign" | "foreign_per_home";
  precision?: number;
}): string => {
  const parsed = decimal(input.quote);
  const precision = input.precision ?? 12;
  const scaled =
    input.direction === "home_per_foreign"
      ? divideHalfUp(
          parsed.coefficient * powerOfTen(precision),
          powerOfTen(parsed.scale) * BigInt(input.foreignUnits),
        )
      : divideHalfUp(
          powerOfTen(parsed.scale + precision) * BigInt(input.foreignUnits),
          parsed.coefficient,
        );
  const digits = scaled.toString().padStart(precision + 1, "0");
  return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(
    /\.?0+$/u,
    "",
  );
};

const convertMinor = (amount: number, rate: Decimal): CentsAmount =>
  cents(
    Number(
      divideHalfUp(BigInt(amount) * rate.coefficient, powerOfTen(rate.scale)),
    ),
  );

export const homeCurrencyVat = (input: {
  country: VatRateCountry;
  rate: string;
  vatBreakdown: readonly VatBreakdownLine[];
}) => {
  const rate = decimal(input.rate);
  const byRate = input.vatBreakdown.map((bucket) => ({
    vatRateBps: bucket.vatRateBps,
    vatTreatment: bucket.vatTreatment,
    // PL ustawa o VAT art. 106e ust. 11: PLN tax is rounded half-up to one grosz.
    vatAmountMinor: convertMinor(bucket.vatAmountMinor, rate),
  }));
  return {
    byRate,
    totalVatAmountMinor: cents(
      byRate.reduce((sum, bucket) => sum + bucket.vatAmountMinor, 0),
    ),
  };
};
