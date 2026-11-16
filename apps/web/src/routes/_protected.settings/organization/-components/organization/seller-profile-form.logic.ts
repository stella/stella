import * as v from "valibot";

import { PARTY_IDENTIFIER_MAX_LENGTH } from "@stll/api-contract";
import type { SELLER_PROFILE_TEXT_FIELDS } from "@stll/api-contract";
import { normalizeIban } from "@stll/invoicing";

import type { SellerProfileInput } from "@/lib/organization/seller-profiles";

/** The profile's text fields; whether it is a VAT payer is a switch. */
type SellerProfileTextField = Exclude<keyof SellerProfileInput, "vatPayer">;

true satisfies Exclude<
  SellerProfileTextField,
  (typeof SELLER_PROFILE_TEXT_FIELDS)[number]
> extends never
  ? true
  : never;

export const SELLER_PROFILE_LIMITS = {
  legalName: 512,
  registrationId: PARTY_IDENTIFIER_MAX_LENGTH,
  taxId: PARTY_IDENTIFIER_MAX_LENGTH,
  vatId: PARTY_IDENTIFIER_MAX_LENGTH,
  registerEntry: 10_000,
  barRegistration: 10_000,
  addressLine1: 512,
  addressLine2: 512,
  city: 256,
  postalCode: 32,
  country: 128,
  iban: 42,
  bic: 11,
  accountNumber: 64,
  defaultCurrency: 3,
  footerNotes: 10_000,
} as const satisfies Record<SellerProfileTextField, number>;

type SellerProfileValidationMessages = {
  required: string;
  invalidField: string;
  invalidIban: string;
  invalidBic: string;
  invalidCurrency: string;
  vatPayerRequiresVatId: string;
};

export const sellerProfileFormSchema = (
  messages: SellerProfileValidationMessages,
) => {
  const optionalText = (maxLength: number) =>
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength, messages.invalidField),
      v.transform((value) => (value === "" ? undefined : value)),
    );
  return v.pipe(
    v.object({
      legalName: v.pipe(
        v.string(),
        v.trim(),
        v.nonEmpty(messages.required),
        v.maxLength(SELLER_PROFILE_LIMITS.legalName, messages.invalidField),
      ),
      registrationId: optionalText(SELLER_PROFILE_LIMITS.registrationId),
      taxId: optionalText(SELLER_PROFILE_LIMITS.taxId),
      vatId: optionalText(SELLER_PROFILE_LIMITS.vatId),
      registerEntry: optionalText(SELLER_PROFILE_LIMITS.registerEntry),
      barRegistration: optionalText(SELLER_PROFILE_LIMITS.barRegistration),
      vatPayer: v.boolean(),
      addressLine1: optionalText(SELLER_PROFILE_LIMITS.addressLine1),
      addressLine2: optionalText(SELLER_PROFILE_LIMITS.addressLine2),
      city: optionalText(SELLER_PROFILE_LIMITS.city),
      postalCode: optionalText(SELLER_PROFILE_LIMITS.postalCode),
      country: optionalText(SELLER_PROFILE_LIMITS.country),
      iban: v.pipe(
        v.string(),
        v.trim(),
        v.rawTransform(({ dataset, addIssue, NEVER }) => {
          if (dataset.value === "") {
            return undefined;
          }
          const normalized = normalizeIban(dataset.value);
          if (normalized === null) {
            addIssue({ message: messages.invalidIban });
            return NEVER;
          }
          return normalized;
        }),
      ),
      bic: v.pipe(
        v.string(),
        v.trim(),
        v.toUpperCase(),
        v.check(
          (value) =>
            value === "" || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/u.test(value),
          messages.invalidBic,
        ),
        v.transform((value) => (value === "" ? undefined : value)),
      ),
      accountNumber: optionalText(SELLER_PROFILE_LIMITS.accountNumber),
      defaultCurrency: v.pipe(
        v.string(),
        v.trim(),
        v.toUpperCase(),
        v.regex(/^[A-Z]{3}$/u, messages.invalidCurrency),
      ),
      footerNotes: optionalText(SELLER_PROFILE_LIMITS.footerNotes),
    } satisfies Record<keyof SellerProfileInput, v.GenericSchema>),
    v.forward(
      v.partialCheck(
        [["vatPayer"], ["vatId"]],
        (input) => !input.vatPayer || input.vatId !== undefined,
        messages.vatPayerRequiresVatId,
      ),
      ["vatId"],
    ),
    v.transform(
      ({
        legalName,
        registrationId,
        taxId,
        vatId,
        registerEntry,
        barRegistration,
        vatPayer,
        addressLine1,
        addressLine2,
        city,
        postalCode,
        country,
        iban,
        bic,
        accountNumber,
        defaultCurrency,
        footerNotes,
      }) =>
        ({
          legalName,
          defaultCurrency,
          vatPayer,
          ...(registrationId === undefined ? {} : { registrationId }),
          ...(taxId === undefined ? {} : { taxId }),
          ...(vatId === undefined ? {} : { vatId }),
          ...(registerEntry === undefined ? {} : { registerEntry }),
          ...(barRegistration === undefined ? {} : { barRegistration }),
          ...(addressLine1 === undefined ? {} : { addressLine1 }),
          ...(addressLine2 === undefined ? {} : { addressLine2 }),
          ...(city === undefined ? {} : { city }),
          ...(postalCode === undefined ? {} : { postalCode }),
          ...(country === undefined ? {} : { country }),
          ...(iban === undefined ? {} : { iban }),
          ...(bic === undefined ? {} : { bic }),
          ...(accountNumber === undefined ? {} : { accountNumber }),
          ...(footerNotes === undefined ? {} : { footerNotes }),
        }) satisfies SellerProfileInput,
    ),
  );
};
