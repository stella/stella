import { t } from "elysia";

import { tCurrencyCode, tSafeId } from "@/api/lib/custom-schema";

const name = t.String({ minLength: 1, maxLength: 512 });
const registrationId = t.String({ maxLength: 64 });
const vatId = t.String({ maxLength: 64 });
const addressLine = t.String({ maxLength: 512 });
const city = t.String({ maxLength: 256 });
const postalCode = t.String({ maxLength: 32 });
const country = t.String({ maxLength: 128 });
const iban = t.String({ minLength: 15, maxLength: 42 });
const bic = t.String({
  maxLength: 11,
  pattern: "^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$",
});
const accountNumber = t.String({ maxLength: 64 });
const footerNotes = t.String({ maxLength: 10_000 });

export const sellerProfileParams = t.Object({
  sellerProfileId: tSafeId("sellerProfile"),
});

export const createSellerProfileBody = t.Object({
  legalName: name,
  registrationId: t.Optional(registrationId),
  vatId: t.Optional(vatId),
  addressLine1: t.Optional(addressLine),
  addressLine2: t.Optional(addressLine),
  city: t.Optional(city),
  postalCode: t.Optional(postalCode),
  country: t.Optional(country),
  iban: t.Optional(iban),
  bic: t.Optional(bic),
  accountNumber: t.Optional(accountNumber),
  defaultCurrency: tCurrencyCode,
  footerNotes: t.Optional(footerNotes),
});

export const updateSellerProfileBody = t.Object({
  legalName: t.Optional(name),
  registrationId: t.Optional(t.Nullable(registrationId)),
  vatId: t.Optional(t.Nullable(vatId)),
  addressLine1: t.Optional(t.Nullable(addressLine)),
  addressLine2: t.Optional(t.Nullable(addressLine)),
  city: t.Optional(t.Nullable(city)),
  postalCode: t.Optional(t.Nullable(postalCode)),
  country: t.Optional(t.Nullable(country)),
  iban: t.Optional(t.Nullable(iban)),
  bic: t.Optional(t.Nullable(bic)),
  accountNumber: t.Optional(t.Nullable(accountNumber)),
  defaultCurrency: t.Optional(tCurrencyCode),
  footerNotes: t.Optional(t.Nullable(footerNotes)),
});

export const SELLER_PROFILE_EDITABLE_FIELDS = [
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
