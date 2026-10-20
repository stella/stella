import { Result } from "better-result";

import type { CentsAmount } from "@stll/money";
import { stripUnicodeMarks } from "@stll/text-normalize";

import { invalidInput, type InvoicingResult } from "./errors";
import { parseNip } from "./nip";
import { parsePaymentAccount } from "./payment-fields";
import type { InvoiceDocumentType } from "./types";

// The Polish Bank Association's payment code (Rekomendacja ZBP dotycząca kodu
// dwuwymiarowego "2D", version 1.0): pipe-separated payee NIP, country,
// 26-digit account, amount in grosze, payee name and payment title, then three
// empty reserve fields. It carries domestic transfers only, so only PLN.

export type PolishQrPaymentInput = {
  documentType: InvoiceDocumentType;
  iban: string;
  amountMinor: CentsAmount;
  currency: string;
  /** The payee's NIP; an institutional payee must carry one. */
  recipientNip: string;
  recipientName: string;
  title: string;
};

export type PolishQrPaymentResult =
  | { status: "payable"; payload: string }
  | { status: "not_payable"; reason: "credit_note" | "not_pln" };

const MAX_NAME_LENGTH = 20;
const MAX_TITLE_LENGTH = 32;
const MIN_AMOUNT_DIGITS = 6;
// The characters the recommendation admits; everything else is dropped.
const DISALLOWED = /[^\w ,./\\\-@#&*ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/gu;
const POLISH_LETTER = /^[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]$/u;

export const buildPolishQrPaymentPayload = ({
  documentType,
  iban,
  amountMinor,
  currency,
  recipientNip,
  recipientName,
  title,
}: PolishQrPaymentInput): InvoicingResult<PolishQrPaymentResult> => {
  if (documentType === "credit_note") {
    return Result.ok({ status: "not_payable", reason: "credit_note" });
  }
  const account = parsePaymentAccount({ iban, amountMinor, currency });
  if (account.isErr()) {
    return Result.err(account.error);
  }
  if (account.value.currency !== "PLN") {
    return Result.ok({ status: "not_payable", reason: "not_pln" });
  }
  if (!account.value.iban.startsWith("PL")) {
    return invalidInput("Polish QR payment requires a Polish IBAN");
  }
  const nip = parseNip(recipientNip);
  if (nip === null) {
    return invalidInput("Polish QR payment requires a valid NIP");
  }
  const name = fieldText(recipientName, MAX_NAME_LENGTH);
  if (!name) {
    return invalidInput("Polish QR payment requires a payee name");
  }
  const paymentTitle = fieldText(title, MAX_TITLE_LENGTH);
  if (!paymentTitle) {
    return invalidInput("Polish QR payment requires a payment title");
  }

  const payload = [
    nip,
    "PL",
    account.value.iban.slice(2),
    String(amountMinor).padStart(MIN_AMOUNT_DIGITS, "0"),
    name,
    paymentTitle,
    "",
    "",
    "",
  ].join("|");
  return Result.ok({ status: "payable", payload });
};

/**
 * Free text in the recommendation's character set: Polish letters stay,
 * other diacritics lose their marks, anything else (the `|` separator
 * included) is dropped, within the field limit.
 */
const fieldText = (value: string, maxLength: number): string =>
  Array.from(value.replaceAll(/\s+/gu, " ").trim(), (character) =>
    POLISH_LETTER.test(character)
      ? character
      : stripUnicodeMarks(character, { form: "NFKD", markClass: "combining" }),
  )
    .join("")
    .replaceAll(DISALLOWED, "")
    .replaceAll(/ {2,}/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
