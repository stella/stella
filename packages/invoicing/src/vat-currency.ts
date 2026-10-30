import { panic } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { cents, type CentsAmount } from "@stll/money";

import type { InvoiceCountry } from "./profiles/country-profiles";
import type { VatBreakdownLine } from "./types";

export type VatRateCountry = Extract<InvoiceCountry, "CZ" | "SK" | "PL">;

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

/** The date the statutory exchange rate is selected relative to. */
export const vatRateReferenceDate = (input: TaxPointInput): string => {
  const taxPoint = vatTaxPointDate(input);
  // PL ustawa o VAT art. 31a ust. 2: an invoice issued before the tax point
  // uses the rate preceding its issue date.
  return input.country === "PL" && input.invoiceDate < taxPoint
    ? input.invoiceDate
    : taxPoint;
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

/** Rounds half away from zero; BigInt division alone truncates toward zero. */
const divideHalfUp = (numerator: bigint, denominator: bigint) => {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return numerator < 0n ? -rounded : rounded;
};

/** Linear trim; a `0+$` pattern backtracks quadratically on long zero runs. */
const withoutTrailingZeros = (digits: string) => {
  let end = digits.length;
  while (end > 0 && digits.at(end - 1) === "0") {
    end -= 1;
  }
  return digits.slice(0, end);
};

/**
 * A stored rate (a decimal string; numeric columns pad zeros) in the reader's
 * locale, without a lossy round trip through a double.
 */
export const formatExchangeRate = (rate: string, locale: string) => {
  const [whole = "0", fraction = ""] = rate.split(".");
  const significant = withoutTrailingZeros(fraction);
  const format = new Intl.NumberFormat(locale);
  const separator =
    format.formatToParts(0.5).find((part) => part.type === "decimal")?.value ??
    ".";
  const grouped = format.format(BigInt(whole));
  return significant === "" ? grouped : `${grouped}${separator}${significant}`;
};

/**
 * How each official source quotes its rate. ČNB and NBP give home currency per
 * foreign unit; ECB gives the foreign currency per euro. The quote is stored
 * as published so a conversion divides once instead of rounding an inverse.
 */
export const VAT_RATE_QUOTE_BASIS = {
  CNB: "home_per_foreign",
  ECB: "foreign_per_home",
  NBP: "home_per_foreign",
} as const;

export type VatRateSource = keyof typeof VAT_RATE_QUOTE_BASIS;

export const isVatRateSource = (value: string): value is VatRateSource =>
  Object.hasOwn(VAT_RATE_QUOTE_BASIS, value);

/** A source quote per one unit of the quoted currency (ČNB quotes 100 JPY). */
export const normalizeVatExchangeRate = (input: {
  quote: string;
  units: bigint;
  precision?: number;
}): string => {
  const parsed = decimal(input.quote);
  const precision = input.precision ?? 12;
  const scaled = divideHalfUp(
    parsed.coefficient * powerOfTen(precision),
    powerOfTen(parsed.scale) * input.units,
  );
  const digits = scaled.toString().padStart(precision + 1, "0");
  const fraction = withoutTrailingZeros(digits.slice(-precision));
  const whole = digits.slice(0, -precision);
  return fraction === "" ? whole : `${whole}.${fraction}`;
};

const convertMinor = (
  amount: number,
  rate: Decimal,
  basis: (typeof VAT_RATE_QUOTE_BASIS)[VatRateSource],
): CentsAmount => {
  // One exact division, rounded once: amount x rate, or amount / rate when the
  // source quotes the foreign currency per home unit.
  const exact =
    basis === "home_per_foreign"
      ? divideHalfUp(BigInt(amount) * rate.coefficient, powerOfTen(rate.scale))
      : divideHalfUp(BigInt(amount) * powerOfTen(rate.scale), rate.coefficient);
  // The shared integer parser owns the bigint-to-number step and its range.
  const minor = parseIntegerToken(exact.toString());
  if (minor.isErr()) {
    return panic("Home-currency VAT exceeds the safe integer range");
  }
  return cents(minor.value);
};

export const homeCurrencyVat = (input: {
  country: VatRateCountry;
  rate: string;
  source: VatRateSource;
  vatBreakdown: readonly VatBreakdownLine[];
}) => {
  const rate = decimal(input.rate);
  const basis = VAT_RATE_QUOTE_BASIS[input.source];
  const byRate = input.vatBreakdown.map((bucket) => ({
    vatRateBps: bucket.vatRateBps,
    vatTreatment: bucket.vatTreatment,
    // PL ustawa o VAT art. 106e ust. 11: PLN tax is rounded half-up to one grosz.
    vatAmountMinor: convertMinor(bucket.vatAmountMinor, rate, basis),
  }));
  return {
    byRate,
    totalVatAmountMinor: cents(
      byRate.reduce((sum, bucket) => sum + bucket.vatAmountMinor, 0),
    ),
  };
};
