import { Result } from "better-result";
import { compress } from "lzma1";

import type { CentsAmount } from "@stll/money";
import { stripUnicodeMarks } from "@stll/text-normalize";

import { invalidInput, type InvoicingResult } from "./errors";
import {
  compactPaymentDate,
  parsePaymentAccount,
  validatePaymentSymbol,
} from "./payment-fields";
import type { InvoiceDocumentType } from "./types";

// PAY by square, the Slovak Banking Association's payment QR (version 1.2.0):
// a tab-separated payment order, prefixed with its CRC32, LZMA-compressed,
// framed by a 2-byte header and a 2-byte length, written in base32hex.
// Slovak banking apps read it; they do not read the Czech SPD code.

export type PayBySquareInput = {
  documentType: InvoiceDocumentType;
  iban: string;
  bic?: string;
  amountMinor: CentsAmount;
  currency: string;
  variableSymbol?: string;
  dueDate?: string;
  message?: string;
  /** Required since version 1.2.0. */
  beneficiaryName: string;
};

export type PayBySquareResult =
  | { status: "payable"; payload: string }
  | { status: "not_payable"; reason: "credit_note" };

/** bySquare type 0 (pay), version 1.2.0, document type 0 (payment order). */
const HEADER = [0x02, 0x00] as const;
const PAYMENT_ORDER = "1";
const MAX_NOTE_LENGTH = 140;
const MAX_BENEFICIARY_NAME_LENGTH = 70;
// The decoder rebuilds the omitted 13-byte LZMA header from these fixed
// properties, so the encoder must use exactly them.
const LZMA_OPTIONS = { lc: 3, lp: 0, pb: 2, dictSize: 131_072 } as const;
const LZMA_HEADER_LENGTH = 13;
const BIC_PATTERN = /^[A-Z]{6}[A-Z\d]{2}(?:[A-Z\d]{3})?$/u;
const BASE32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

export const buildPayBySquarePayload = ({
  documentType,
  iban,
  bic,
  amountMinor,
  currency,
  variableSymbol,
  dueDate,
  message,
  beneficiaryName,
}: PayBySquareInput): InvoicingResult<PayBySquareResult> => {
  if (documentType === "credit_note") {
    return Result.ok({ status: "not_payable", reason: "credit_note" });
  }
  const account = parsePaymentAccount({ iban, amountMinor, currency });
  if (account.isErr()) {
    return Result.err(account.error);
  }
  const name = fieldText(beneficiaryName, MAX_BENEFICIARY_NAME_LENGTH);
  if (!name) {
    return invalidInput("PAY by square requires a beneficiary name");
  }

  let symbol = "";
  if (variableSymbol !== undefined) {
    const validSymbol = validatePaymentSymbol(variableSymbol, "Variable");
    if (validSymbol.isErr()) {
      return Result.err(validSymbol.error);
    }
    symbol = validSymbol.value;
  }
  let date = "";
  if (dueDate !== undefined) {
    const validDate = compactPaymentDate(dueDate);
    if (validDate.isErr()) {
      return Result.err(validDate.error);
    }
    date = validDate.value;
  }
  // BIC is optional for SEPA payments: a malformed one is left out rather
  // than failing the invoice.
  const normalizedBic = bic?.replaceAll(/\s/gu, "").toUpperCase() ?? "";

  // Field order of the pay data model (one payment, one account, no standing
  // order or direct debit), then the beneficiary block.
  const fields = [
    "",
    "1",
    PAYMENT_ORDER,
    account.value.amount,
    account.value.currency,
    date,
    symbol,
    "",
    "",
    "",
    message === undefined ? "" : fieldText(message, MAX_NOTE_LENGTH),
    "1",
    account.value.iban,
    BIC_PATTERN.test(normalizedBic) ? normalizedBic : "",
    "0",
    "0",
    name,
    "",
    "",
  ];

  return Result.ok({ status: "payable", payload: encode(fields.join("\t")) });
};

/** The framed, compressed, base32hex form of a tab-separated data model. */
const encode = (dataModel: string): string => {
  const text = new TextEncoder().encode(dataModel);
  const checked = new Uint8Array(4 + text.length);
  // IEEE CRC32. Only the API (Bun) imports this subpath; the web bundle does
  // not, so Bun's own implementation is available.
  new DataView(checked.buffer).setUint32(0, Bun.hash.crc32(text), true);
  checked.set(text, 4);
  const body = compress(checked, LZMA_OPTIONS).subarray(LZMA_HEADER_LENGTH);
  const framed = new Uint8Array(4 + body.length);
  framed.set(HEADER, 0);
  new DataView(framed.buffer).setUint16(2, checked.length, true);
  framed.set(body, 4);
  return base32hex(framed);
};

/** RFC 4648 base32hex without padding, as the QR carries it. */
const base32hex = (bytes: Uint8Array): string => {
  const bits = Array.from(bytes, (byte) =>
    byte.toString(2).padStart(8, "0"),
  ).join("");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    const group = bits.slice(index, index + 5).padEnd(5, "0");
    output += BASE32HEX[Number.parseInt(group, 2)];
  }
  return output;
};

/**
 * Free text the banking apps accept: no diacritics (many apps reject them),
 * no tabs (the field separator), collapsed whitespace, within the field limit.
 */
const fieldText = (value: string, maxLength: number): string =>
  stripUnicodeMarks(value, { form: "NFKD", markClass: "combining" })
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
