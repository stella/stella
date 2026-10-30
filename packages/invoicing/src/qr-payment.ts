import { Result } from "better-result";

import type { CentsAmount } from "@stll/money";
import { normalizeUnicode } from "@stll/text-normalize";

import type { InvoicingResult } from "./errors";
import {
  compactPaymentDate,
  parsePaymentAccount,
  validatePaymentSymbol,
} from "./payment-fields";
import type { InvoiceDocumentType } from "./types";

export type CzechQrPaymentInput = {
  documentType: InvoiceDocumentType;
  iban: string;
  amountMinor: CentsAmount;
  currency: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  dueDate?: string;
  message?: string;
};

export type CzechQrPaymentResult =
  | { status: "payable"; payload: string }
  | { status: "not_payable"; reason: "credit_note" };

const QR_PAYMENT_VERSION = "1.0";
const MAX_MESSAGE_LENGTH = 60;

export const buildCzechQrPaymentPayload = ({
  documentType,
  iban,
  amountMinor,
  currency,
  variableSymbol,
  constantSymbol,
  specificSymbol,
  dueDate,
  message,
}: CzechQrPaymentInput): InvoicingResult<CzechQrPaymentResult> => {
  if (documentType === "credit_note") {
    return Result.ok({ status: "not_payable", reason: "credit_note" });
  }
  const account = parsePaymentAccount({ iban, amountMinor, currency });
  if (account.isErr()) {
    return Result.err(account.error);
  }

  const fields = [
    "SPD",
    QR_PAYMENT_VERSION,
    `ACC:${account.value.iban}`,
    `AM:${account.value.amount}`,
    `CC:${account.value.currency}`,
  ];

  for (const [value, kind, field] of [
    [variableSymbol, "Variable", "X-VS"],
    [constantSymbol, "Constant", "X-KS"],
    [specificSymbol, "Specific", "X-SS"],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    const symbol = validatePaymentSymbol(value, kind);
    if (symbol.isErr()) {
      return Result.err(symbol.error);
    }
    fields.push(`${field}:${symbol.value}`);
  }
  if (dueDate !== undefined) {
    const date = compactPaymentDate(dueDate);
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
