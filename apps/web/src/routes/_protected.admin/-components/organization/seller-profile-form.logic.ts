import * as v from "valibot";

import { normalizeIban } from "@stll/invoicing";

import type { SellerProfileInput } from "@/lib/organization/seller-profiles";

export const SELLER_PROFILE_FIELDS = [
  "legalName",
  "registrationId",
  "vatId",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "country",
  "iban",
  "bic",
  "accountNumber",
  "defaultCurrency",
  "footerNotes",
] as const;

true satisfies Exclude<
  keyof SellerProfileInput,
  (typeof SELLER_PROFILE_FIELDS)[number]
> extends never
  ? true
  : never;

export const SELLER_PROFILE_LIMITS = {
  legalName: 512,
  registrationId: 64,
  vatId: 64,
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
} as const satisfies Record<keyof SellerProfileInput, number>;

type SellerProfileValidationMessages = {
  required: string;
  invalidField: string;
  invalidIban: string;
  invalidBic: string;
  invalidCurrency: string;
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
      vatId: optionalText(SELLER_PROFILE_LIMITS.vatId),
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
    v.transform(
      ({
        legalName,
        registrationId,
        vatId,
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
          ...(registrationId === undefined ? {} : { registrationId }),
          ...(vatId === undefined ? {} : { vatId }),
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
