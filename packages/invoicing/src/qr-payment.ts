import { panic, Result } from "better-result";
import { encode as encodePayBySquare, PaymentOptions } from "bysquare/pay";

import { cents, currencyMinorUnitDigits, type CentsAmount } from "@stll/money";
import { normalizeUnicode } from "@stll/text-normalize";

import { invalidInput, type InvoicingResult } from "./errors";
import { parseIban } from "./iban";
import type { InvoiceDocumentType } from "./types";

export type CzechQrPaymentInput = {
  documentType: InvoiceDocumentType;
  iban: string;
  amountMinor: CentsAmount;
  currency: string;
  variableSymbol?: string;
  dueDate?: string;
  message?: string;
};

export type CzechQrPaymentResult =
  | { status: "payable"; payload: string }
  | { status: "not_payable"; reason: "credit_note" };

const QR_PAYMENT_VERSION = "1.0";
const MAX_MESSAGE_LENGTH = 60;
const PAY_BY_SQUARE_MAX_NOTE_LENGTH = 140;
const PAY_BY_SQUARE_MAX_NAME_LENGTH = 70;
const PAY_BY_SQUARE_AMOUNT_SCALE = 10 ** 2;

export type PayBySquareInput = {
  amount: number;
  currency: string;
  /** Optional in PAY by square 1.2: an absent due date is omitted from the order. */
  dueDate?: string;
  variableSymbol?: string;
  paymentNote: string;
  iban: string;
  bic?: string;
  beneficiaryName: string;
};

export type PaymentQrScheme = "spayd" | "pay_by_square";

/** Selects the domestic payment standard from validated account geography and currency. */
export const paymentQrSchemeFor = ({
  iban,
  currency,
}: Pick<PayBySquareInput, "iban" | "currency">): PaymentQrScheme | null => {
  const account = parseIban(iban);
  if (account.isErr()) {
    return null;
  }
  const country = account.value.slice(0, 2);
  let accountRegion: "cz" | "sk" | "other" = "other";
  if (country === "CZ") {
    accountRegion = "cz";
  } else if (country === "SK") {
    accountRegion = "sk";
  }
  switch (accountRegion) {
    case "cz":
      switch (currency.toUpperCase()) {
        case "CZK":
        case "EUR":
          return "spayd";
        default:
          return null;
      }
    case "sk":
      return currency.toUpperCase() === "EUR" ? "pay_by_square" : null;
    case "other":
      return null;
    default: {
      accountRegion satisfies never;
      return panic("Unknown payment account region");
    }
  }
};

/** Builds a PAY by square 1.2 payment-order document. */
export const buildPayBySquarePayload = ({
  amount,
  currency,
  dueDate,
  variableSymbol,
  paymentNote,
  iban,
  bic,
  beneficiaryName,
}: PayBySquareInput): InvoicingResult<CzechQrPaymentResult> => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return invalidInput("PAY by square amount must be positive");
  }
  const normalizedCurrency = currency.toUpperCase();
  if (!Intl.supportedValuesOf("currency").includes(normalizedCurrency)) {
    return invalidInput("PAY by square requires an ISO currency code");
  }
  const account = parseIban(iban);
  if (account.isErr()) {
    return invalidInput(
      account.error.message === "IBAN checksum is invalid"
        ? "PAY by square requires a valid IBAN checksum"
        : "PAY by square requires a valid IBAN",
    );
  }
  const symbol =
    variableSymbol === undefined
      ? Result.ok(undefined)
      : validateVariableSymbol(variableSymbol);
  if (symbol.isErr()) {
    return Result.err(symbol.error);
  }
  const date =
    dueDate === undefined ? Result.ok(undefined) : formatDate(dueDate);
  if (date.isErr()) {
    return Result.err(date.error);
  }
  const normalizedBic = bic?.replaceAll(/\s/gu, "").toUpperCase();
  if (
    normalizedBic !== undefined &&
    !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/u.test(normalizedBic)
  ) {
    return invalidInput("PAY by square requires a valid BIC");
  }
  const name = clipPayBySquareField(
    beneficiaryName,
    PAY_BY_SQUARE_MAX_NAME_LENGTH,
  );
  if (name === "") {
    return invalidInput("PAY by square requires a beneficiary name");
  }

  const roundedAmount =
    Math.round((amount + Number.EPSILON) * PAY_BY_SQUARE_AMOUNT_SCALE) /
    PAY_BY_SQUARE_AMOUNT_SCALE;
  const payload = encodePayBySquare(
    {
      payments: [
        {
          type: PaymentOptions.PaymentOrder,
          amount: roundedAmount,
          currencyCode: normalizedCurrency,
          ...(date.value === undefined ? {} : { paymentDueDate: date.value }),
          ...(symbol.value === undefined
            ? {}
            : { variableSymbol: symbol.value }),
          paymentNote: clipPayBySquareField(
            paymentNote,
            PAY_BY_SQUARE_MAX_NOTE_LENGTH,
          ),
          bankAccounts: [
            {
              iban: account.value,
              ...(normalizedBic === undefined ? {} : { bic: normalizedBic }),
            },
          ],
          beneficiary: { name },
        },
      ],
    },
    { deburr: false, validate: false },
  );
  return Result.ok({ status: "payable", payload });
};

export const buildCzechQrPaymentPayload = ({
  documentType,
  iban,
  amountMinor,
  currency,
  variableSymbol,
  dueDate,
  message,
}: CzechQrPaymentInput): InvoicingResult<CzechQrPaymentResult> => {
  if (documentType === "credit_note") {
    return Result.ok({ status: "not_payable", reason: "credit_note" });
  }
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

  const fields = [
    "SPD",
    QR_PAYMENT_VERSION,
    `ACC:${account.value}`,
    `AM:${formatMinorAmount(cents(amountMinor), normalizedCurrency)}`,
    `CC:${normalizedCurrency}`,
  ];

  if (variableSymbol !== undefined) {
    const symbol = validateVariableSymbol(variableSymbol);
    if (symbol.isErr()) {
      return Result.err(symbol.error);
    }
    fields.push(`X-VS:${symbol.value}`);
  }
  if (dueDate !== undefined) {
    const date = formatDate(dueDate);
    if (date.isErr()) {
      return Result.err(date.error);
    }
    fields.push(`DT:${date.value}`);
  }
  if (message) {
    const sanitizedMessage = sanitizeFieldValue(message);
    if (sanitizedMessage) {
      fields.push(`MSG:${sanitizedMessage}`);
    }
  }

  return Result.ok({ status: "payable", payload: fields.join("*") });
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

const validateVariableSymbol = (
  variableSymbol: string,
): InvoicingResult<string> => {
  if (!/^\d{1,10}$/u.test(variableSymbol)) {
    return invalidInput("Variable symbol must contain 1 to 10 digits");
  }
  return Result.ok(variableSymbol);
};

const formatDate = (date: string): InvoicingResult<string> => {
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

const sanitizeFieldValue = (value: string): string => {
  const normalized = normalizeUnicode(value, "NFKC")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const encoded: string[] = [];
  let length = 0;
  for (const character of normalized) {
    let token = character;
    if (character === "*") {
      token = "%2A";
    } else if (character === "%") {
      token = "%25";
    }
    if (length + token.length > MAX_MESSAGE_LENGTH) {
      break;
    }
    encoded.push(token);
    length += token.length;
  }
  return encoded.join("");
};

const clipPayBySquareField = (value: string, maxLength: number): string =>
  Array.from(
    normalizeUnicode(value, "NFC")
      .replaceAll(/[\t\r\n]+/gu, " ")
      .trim(),
  )
    .slice(0, maxLength)
    .join("");
