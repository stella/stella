import { cents, currencyMinorUnitDigits, type CentsAmount } from "@stll/money";

import { InvoicingInputError } from "./errors";
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
}: CzechQrPaymentInput): CzechQrPaymentResult => {
  if (documentType === "credit_note") {
    return { status: "not_payable", reason: "credit_note" };
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new InvoicingInputError({
      message: "QR payment amount must be a positive minor amount",
    });
  }

  const normalizedCurrency = currency.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalizedCurrency)) {
    throw new InvoicingInputError({
      message: "QR payment requires a three-letter currency code",
    });
  }

  const fields = [
    "SPD",
    QR_PAYMENT_VERSION,
    `ACC:${normalizeIban(iban)}`,
    `AM:${formatMinorAmount(cents(amountMinor), normalizedCurrency)}`,
    `CC:${normalizedCurrency}`,
  ];

  if (variableSymbol) {
    fields.push(`X-VS:${sanitizeVariableSymbol(variableSymbol)}`);
  }
  if (dueDate) {
    fields.push(`DT:${formatDate(dueDate)}`);
  }
  if (message) {
    const sanitizedMessage = sanitizeFieldValue(message);
    if (sanitizedMessage) {
      fields.push(`MSG:${sanitizedMessage}`);
    }
  }

  return { status: "payable", payload: fields.join("*") };
};

const normalizeIban = (iban: string): string => {
  const normalized = iban.replaceAll(/\s/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(normalized)) {
    throw new InvoicingInputError({
      message: "QR payment requires a valid IBAN",
    });
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
    throw new InvoicingInputError({
      message: "QR payment requires a valid IBAN checksum",
    });
  }
  return normalized;
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

const sanitizeVariableSymbol = (variableSymbol: string): string => {
  const sanitized = variableSymbol.replaceAll(/\D/gu, "").slice(0, 10);
  if (sanitized.length === 0) {
    throw new InvoicingInputError({
      message: "Variable symbol must contain at least one digit",
    });
  }
  return sanitized;
};

const formatDate = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new InvoicingInputError({
      message: "QR payment due date must use YYYY-MM-DD",
    });
  }
  return date.replaceAll("-", "");
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
