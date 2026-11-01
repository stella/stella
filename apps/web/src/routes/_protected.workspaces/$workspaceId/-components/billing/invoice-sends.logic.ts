import * as v from "valibot";

import { INVOICE_SEND_LIMITS } from "@stll/api-contract";

const emailSchema = v.pipe(v.string(), v.email());

/** Addresses typed one per line or separated by commas or semicolons. */
export const splitRecipients = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,;]+/u)
      .map((address) => address.trim())
      .filter((address) => address !== ""),
  ),
];

type SendInvoiceFormMessages = {
  required: string;
  tooMany: string;
  invalid: string;
  messageTooLong: string;
};

export const sendInvoiceFormSchema = (messages: SendInvoiceFormMessages) =>
  v.strictObject({
    recipients: v.pipe(
      v.string(),
      v.transform(splitRecipients),
      v.minLength(INVOICE_SEND_LIMITS.minRecipients, messages.required),
      v.maxLength(INVOICE_SEND_LIMITS.maxRecipients, messages.tooMany),
      v.check(
        (addresses) => addresses.every((address) => v.is(emailSchema, address)),
        messages.invalid,
      ),
    ),
    message: v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(INVOICE_SEND_LIMITS.messageMaxChars, messages.messageTooLong),
    ),
  });

/** What the dialog starts from: the given addresses, else the client's. */
export const initialRecipientsText = (
  given: readonly string[] | null,
  clientAddresses: readonly string[],
) => (given ?? clientAddresses).join("\n");
