import { Result } from "better-result";

import { cents, type CentsAmount, currencyMinorUnitDigits } from "@stll/money";

import { invalidInput, type InvoicingResult } from "./errors";
import { parseIban } from "./iban";

// Validation shared by every payment QR standard (qr-payment.ts,
// pay-by-square.ts): one amount, currency, account, symbol and date rule set.

export type PaymentAccount = {
  /** Normalized IBAN. */
  iban: string;
  /** Upper-case ISO 4217 code. */
  currency: string;
  /** Decimal amount in major units, e.g. `1234.50`. */
  amount: string;
};

export const parsePaymentAccount = ({
  iban,
  amountMinor,
  currency,
}: {
  iban: string;
  amountMinor: CentsAmount;
  currency: string;
}): InvoicingResult<PaymentAccount> => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return invalidInput("QR payment amount must be a positive minor amount");
  }

  const normalizedCurrency = currency.toUpperCase();
  if (!Intl.supportedValuesOf("currency").includes(normalizedCurrency)) {
    return invalidInput("QR payment requires an ISO currency code");
  }

  const account = parseIban(iban);
  if (account.isErr()) {
    return invalidInput(
      account.error.message === "IBAN checksum is invalid"
        ? "QR payment requires a valid IBAN checksum"
        : "QR payment requires a valid IBAN",
    );
  }

  return Result.ok({
    iban: account.value,
    currency: normalizedCurrency,
    amount: formatMinorAmount(cents(amountMinor), normalizedCurrency),
  });
};

const formatMinorAmount = (
  amountMinor: CentsAmount,
  currency: string,
): string => {
  const digits = currencyMinorUnitDigits(currency);
  const scale = 10n ** BigInt(digits);
  const amount = BigInt(amountMinor);
  if (digits === 0) {
    return String(amount);
  }
  return `${amount / scale}.${String(amount % scale).padStart(digits, "0")}`;
};

export const validatePaymentSymbol = (
  symbol: string,
  kind: "Variable" | "Constant" | "Specific",
): InvoicingResult<string> => {
  if (!/^\d{1,10}$/u.test(symbol)) {
    return invalidInput(`${kind} symbol must contain 1 to 10 digits`);
  }
  return Result.ok(symbol);
};

/** `YYYY-MM-DD` as `YYYYMMDD`, refusing dates that do not exist. */
export const compactPaymentDate = (date: string): InvoicingResult<string> => {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(date);
  if (!match?.groups) {
    return invalidInput("QR payment due date must use YYYY-MM-DD");
  }
  const year = Number(match.groups["year"]);
  const month = Number(match.groups["month"]);
  const day = Number(match.groups["day"]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ].at(month - 1);
  if (year === 0 || daysInMonth === undefined || day < 1 || day > daysInMonth) {
    return invalidInput("QR payment due date must be a real calendar date");
  }
  return Result.ok(date.replaceAll("-", ""));
};
