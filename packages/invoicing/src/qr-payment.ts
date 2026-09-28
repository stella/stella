import { Result } from "better-result";

import { cents, currencyMinorUnitDigits, type CentsAmount } from "@stll/money";

import { invalidInput, type InvoicingResult } from "./errors";
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
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

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

  const account = normalizeIban(iban);
  if (account.isErr()) {
    return Result.err(account.error);
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

const normalizeIban = (iban: string): InvoicingResult<string> => {
  const normalized = iban.replaceAll(/\s/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(normalized)) {
    return invalidInput("QR payment requires a valid IBAN");
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/u.test(character)
      ? character
      : String(ALPHABET.indexOf(character) + 10);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  if (remainder !== 1) {
    return invalidInput("QR payment requires a valid IBAN checksum");
  }
  return Result.ok(normalized);
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
  const normalized = value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
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
