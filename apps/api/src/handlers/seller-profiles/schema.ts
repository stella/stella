import * as v from "valibot";

import { PARTY_IDENTIFIER_MAX_LENGTH } from "@stll/api-contract";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";

import { resourceIdSchema } from "@/api/lib/custom-schema";

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const registrationId = v.pipe(
  v.string(),
  v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH),
);
const taxId = v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH));
const vatId = v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH));
const vatPayer = v.pipe(
  v.boolean(),
  v.description(
    "Whether the issuer charges VAT. Requires a VAT ID; a registered person who is not a VAT payer has a VAT ID but sets this to false.",
  ),
);
const addressLine = v.pipe(v.string(), v.maxLength(512));
const city = v.pipe(v.string(), v.maxLength(256));
const postalCode = v.pipe(v.string(), v.maxLength(32));
const country = v.pipe(v.string(), v.maxLength(128));
const iban = v.pipe(v.string(), v.minLength(15), v.maxLength(42));
const bic = v.pipe(
  v.string(),
  v.maxLength(11),
  v.regex(/^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/u),
);
const accountNumber = v.pipe(v.string(), v.maxLength(64));
const footerNotes = v.pipe(v.string(), v.maxLength(10_000));
const registrationText = v.pipe(v.string(), v.maxLength(10_000));

export const sellerProfileParams = v.object({
  sellerProfileId: resourceIdSchema("sellerProfile"),
});

export const createSellerProfileBody = v.object({
  legalName: name,
  registrationId: v.optional(registrationId),
  taxId: v.optional(taxId),
  vatId: v.optional(vatId),
  registerEntry: v.optional(registrationText),
  barRegistration: v.optional(registrationText),
  vatPayer: v.optional(vatPayer),
  addressLine1: v.optional(addressLine),
  addressLine2: v.optional(addressLine),
  city: v.optional(city),
  postalCode: v.optional(postalCode),
  country: v.optional(country),
  iban: v.optional(iban),
  bic: v.optional(bic),
  accountNumber: v.optional(accountNumber),
  defaultCurrency: currencyCodeSchema,
  footerNotes: v.optional(footerNotes),
});

export const updateSellerProfileBody = v.object({
  legalName: v.optional(name),
  registrationId: v.optional(v.nullable(registrationId)),
  taxId: v.optional(v.nullable(taxId)),
  vatId: v.optional(v.nullable(vatId)),
  registerEntry: v.optional(v.nullable(registrationText)),
  barRegistration: v.optional(v.nullable(registrationText)),
  vatPayer: v.optional(vatPayer),
  addressLine1: v.optional(v.nullable(addressLine)),
  addressLine2: v.optional(v.nullable(addressLine)),
  city: v.optional(v.nullable(city)),
  postalCode: v.optional(v.nullable(postalCode)),
  country: v.optional(v.nullable(country)),
  iban: v.optional(v.nullable(iban)),
  bic: v.optional(v.nullable(bic)),
  accountNumber: v.optional(v.nullable(accountNumber)),
  defaultCurrency: v.optional(currencyCodeSchema),
  footerNotes: v.optional(v.nullable(footerNotes)),
});

export const SELLER_PROFILE_EDITABLE_FIELDS = [
  "legalName",
  "registrationId",
  "taxId",
  "vatId",
  "registerEntry",
  "barRegistration",
  "vatPayer",
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

/** A VAT payer must carry the VAT ID it charges VAT under. */
export const vatPayerWithoutVatId = (
  payer: boolean,
  id: string | null | undefined,
) => payer && (id ?? "").trim() === "";

export const VAT_PAYER_REQUIRES_VAT_ID = {
  status: 400,
  code: "vat_payer_requires_vat_id",
  message: "A VAT payer needs a VAT ID",
  hint: "Set vatId together with vatPayer: true, or set vatPayer: false for an issuer who does not charge VAT.",
} as const;
