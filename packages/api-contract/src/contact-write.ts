import * as v from "valibot";

import { INVOICE_LANGUAGES } from "./billing";
import { contactBirthDateSchema } from "./contact-date";
import { PARTY_IDENTIFIER_MAX_LENGTH } from "./party-identifiers";
import { userIdSchema } from "./safe-id";
import { CONTACT_TYPES } from "./workspace-contacts";

const contactCurrencyCodeSchema = v.pipe(
  v.string(),
  v.length(3),
  v.regex(/^[A-Za-z]{3}$/u),
  v.transform((code) => code.toUpperCase()),
);

export const MAX_CONTACT_NATIONALITY_CODES = 250;

export const contactNationalityCodesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
  v.maxLength(MAX_CONTACT_NATIONALITY_CODES),
  v.check(
    (codes) => new Set(codes).size === codes.length,
    "Nationality codes must be unique",
  ),
);

export const contactBankAccountSchema = v.object({
  iban: v.exactOptional(v.pipe(v.string(), v.maxLength(34))),
  bic: v.exactOptional(v.pipe(v.string(), v.maxLength(11))),
  accountNumber: v.exactOptional(v.pipe(v.string(), v.maxLength(64))),
  bankName: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  currency: v.exactOptional(contactCurrencyCodeSchema),
});

export const contactBillingAddressSchema = v.object({
  line1: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  line2: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  city: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  state: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  postalCode: v.exactOptional(v.pipe(v.string(), v.maxLength(32))),
  country: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export const contactEmailSchema = v.object({
  type: v.picklist(["work", "personal", "other"]),
  address: v.pipe(v.string(), v.email(), v.maxLength(320)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export const contactPhoneSchema = v.object({
  type: v.picklist(["mobile", "office", "home", "fax", "other"]),
  number: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export const contactDataBoxSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{7}$/u)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export const contactCustomFieldSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  value: v.pipe(v.string(), v.maxLength(2000)),
});

export const contactMetadataSchema = v.object({
  dataBoxes: v.exactOptional(
    v.pipe(v.array(contactDataBoxSchema), v.maxLength(20)),
  ),
  customFields: v.exactOptional(
    v.pipe(v.array(contactCustomFieldSchema), v.maxLength(50)),
  ),
});

export const contactAddressSchema = v.object({
  type: v.picklist([
    "office",
    "mailing",
    "billing",
    "service",
    "home",
    "other",
  ]),
  line1: v.pipe(v.string(), v.maxLength(512)),
  line2: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  city: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  state: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  postalCode: v.exactOptional(v.pipe(v.string(), v.maxLength(32))),
  country: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

const minorUnitAmountSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

export const contactCreateFieldsSchema = v.object({
  type: v.picklist(CONTACT_TYPES),
  prefix: v.optional(v.pipe(v.string(), v.maxLength(32))),
  firstName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  middleName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  lastName: v.optional(v.pipe(v.string(), v.maxLength(256))),
  suffix: v.optional(v.pipe(v.string(), v.maxLength(32))),
  dateOfBirth: v.optional(contactBirthDateSchema),
  nationalityCodes: v.optional(contactNationalityCodesSchema),
  organizationName: v.optional(v.pipe(v.string(), v.maxLength(512))),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  notes: v.optional(v.string()),
  emails: v.optional(v.pipe(v.array(contactEmailSchema), v.maxLength(20))),
  phones: v.optional(v.pipe(v.array(contactPhoneSchema), v.maxLength(20))),
  addresses: v.optional(v.pipe(v.array(contactAddressSchema), v.maxLength(10))),
  metadata: v.optional(contactMetadataSchema),
  tags: v.optional(v.pipe(v.array(v.string()), v.maxLength(50))),
  color: v.optional(v.pipe(v.string(), v.maxLength(32))),
  registrationNumber: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  taxId: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  vatId: v.optional(
    v.pipe(v.string(), v.maxLength(PARTY_IDENTIFIER_MAX_LENGTH)),
  ),
  vatPayer: v.optional(v.nullable(v.boolean())),
  bankAccounts: v.optional(
    v.pipe(v.array(contactBankAccountSchema), v.maxLength(10)),
  ),
  billingAddress: v.optional(contactBillingAddressSchema),
  defaultHourlyRate: v.optional(minorUnitAmountSchema),
  currency: v.optional(v.pipe(v.string(), v.minLength(3), v.maxLength(3))),
  paymentTermDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(365)),
  ),
  invoiceLanguage: v.optional(v.nullable(v.picklist(INVOICE_LANGUAGES))),
  originatingAttorneyId: v.optional(userIdSchema),
  responsibleAttorneyId: v.optional(userIdSchema),
});

const nullableContactUpdateEntries = {
  prefix: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.prefix.wrapped),
  ),
  firstName: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.firstName.wrapped),
  ),
  middleName: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.middleName.wrapped),
  ),
  lastName: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.lastName.wrapped),
  ),
  suffix: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.suffix.wrapped),
  ),
  dateOfBirth: v.optional(v.nullable(contactBirthDateSchema)),
  nationalityCodes: v.optional(v.nullable(contactNationalityCodesSchema)),
  organizationName: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.organizationName.wrapped),
  ),
  notes: v.optional(v.nullable(v.string())),
  emails: v.optional(
    v.nullable(v.pipe(v.array(contactEmailSchema), v.maxLength(20))),
  ),
  phones: v.optional(
    v.nullable(v.pipe(v.array(contactPhoneSchema), v.maxLength(20))),
  ),
  addresses: v.optional(
    v.nullable(v.pipe(v.array(contactAddressSchema), v.maxLength(10))),
  ),
  metadata: v.optional(v.nullable(contactMetadataSchema)),
  tags: v.optional(v.nullable(v.pipe(v.array(v.string()), v.maxLength(50)))),
  color: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.color.wrapped),
  ),
  registrationNumber: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.registrationNumber.wrapped),
  ),
  taxId: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.taxId.wrapped),
  ),
  vatId: v.optional(
    v.nullable(contactCreateFieldsSchema.entries.vatId.wrapped),
  ),
  vatPayer: v.optional(v.nullable(v.boolean())),
  bankAccounts: v.optional(
    v.nullable(v.pipe(v.array(contactBankAccountSchema), v.maxLength(10))),
  ),
  billingAddress: v.optional(v.nullable(contactBillingAddressSchema)),
  defaultHourlyRate: v.optional(v.nullable(minorUnitAmountSchema)),
  currency: v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(3), v.maxLength(3))),
  ),
  paymentTermDays: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(365))),
  ),
  invoiceLanguage: v.optional(v.nullable(v.picklist(INVOICE_LANGUAGES))),
  originatingAttorneyId: v.optional(v.nullable(userIdSchema)),
  responsibleAttorneyId: v.optional(v.nullable(userIdSchema)),
};

export const updateContactBodySchema = v.object({
  type: v.optional(v.picklist(CONTACT_TYPES)),
  ...nullableContactUpdateEntries,
  displayName: v.optional(contactCreateFieldsSchema.entries.displayName),
});

export type ContactBankAccount = v.InferOutput<typeof contactBankAccountSchema>;
export type ContactBillingAddress = v.InferOutput<
  typeof contactBillingAddressSchema
>;
export type ContactEmail = v.InferOutput<typeof contactEmailSchema>;
export type ContactPhone = v.InferOutput<typeof contactPhoneSchema>;
export type ContactDataBox = v.InferOutput<typeof contactDataBoxSchema>;
export type ContactCustomField = v.InferOutput<typeof contactCustomFieldSchema>;
export type ContactMetadata = v.InferOutput<typeof contactMetadataSchema>;
export type ContactAddress = v.InferOutput<typeof contactAddressSchema>;
