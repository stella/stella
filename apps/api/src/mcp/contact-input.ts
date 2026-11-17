import * as v from "valibot";

import {
  contactAddressSchema,
  contactBankAccountSchema,
  contactBillingAddressSchema,
  contactDataBoxSchema,
  contactEmailSchema,
  contactMetadataSchema,
  contactPhoneSchema,
  updateContactBodySchema,
} from "@stll/api-contract/contact-write";

const { isPrimary: emailPrimary, ...emailEntries } = contactEmailSchema.entries;
const emailInput = v.pipe(
  v.strictObject({ ...emailEntries, is_primary: emailPrimary }),
  v.transform(({ is_primary, ...email }) => ({
    ...email,
    isPrimary: is_primary,
  })),
);

const { isPrimary: phonePrimary, ...phoneEntries } = contactPhoneSchema.entries;
const phoneInput = v.pipe(
  v.strictObject({ ...phoneEntries, is_primary: phonePrimary }),
  v.transform(({ is_primary, ...phone }) => ({
    ...phone,
    isPrimary: is_primary,
  })),
);

const {
  isPrimary: addressPrimary,
  postalCode: addressPostalCode,
  ...addressEntries
} = contactAddressSchema.entries;
const addressInput = v.pipe(
  v.strictObject({
    ...addressEntries,
    is_primary: addressPrimary,
    postal_code: addressPostalCode,
  }),
  v.transform(({ is_primary, postal_code, ...address }) => ({
    ...address,
    isPrimary: is_primary,
    ...(postal_code === undefined ? {} : { postalCode: postal_code }),
  })),
);

const { isPrimary: dataBoxPrimary, ...dataBoxEntries } =
  contactDataBoxSchema.entries;
const dataBoxInput = v.pipe(
  v.strictObject({ ...dataBoxEntries, is_primary: dataBoxPrimary }),
  v.transform(({ is_primary, ...dataBox }) => ({
    ...dataBox,
    isPrimary: is_primary,
  })),
);

const { accountNumber, bankName, ...bankEntries } =
  contactBankAccountSchema.entries;
const bankInput = v.pipe(
  v.strictObject({
    ...bankEntries,
    account_number: accountNumber,
    bank_name: bankName,
  }),
  v.transform(({ account_number, bank_name, ...bank }) => ({
    ...bank,
    ...(account_number === undefined ? {} : { accountNumber: account_number }),
    ...(bank_name === undefined ? {} : { bankName: bank_name }),
  })),
);

const { postalCode, ...billingAddressEntries } =
  contactBillingAddressSchema.entries;
const billingAddressInput = v.pipe(
  v.strictObject({ ...billingAddressEntries, postal_code: postalCode }),
  v.transform(({ postal_code, ...address }) => ({
    ...address,
    ...(postal_code === undefined ? {} : { postalCode: postal_code }),
  })),
);

const { dataBoxes, customFields, ...metadataEntries } =
  contactMetadataSchema.entries;
const [, ...dataBoxConstraints] = dataBoxes.wrapped.pipe;
const [, ...customFieldConstraints] = customFields.wrapped.pipe;
const metadataInput = v.pipe(
  v.strictObject({
    ...metadataEntries,
    data_boxes: v.exactOptional(
      v.pipe(v.array(dataBoxInput), ...dataBoxConstraints),
    ),
    custom_fields: v.exactOptional(
      v.pipe(
        v.array(v.strictObject(customFields.wrapped.pipe[0].item.entries)),
        ...customFieldConstraints,
      ),
    ),
  }),
  v.transform(({ data_boxes, custom_fields, ...metadata }) => ({
    ...metadata,
    ...(data_boxes === undefined ? {} : { dataBoxes: data_boxes }),
    ...(custom_fields === undefined ? {} : { customFields: custom_fields }),
  })),
);

const [, ...emailConstraints] =
  updateContactBodySchema.entries.emails.wrapped.wrapped.pipe;
const [, ...phoneConstraints] =
  updateContactBodySchema.entries.phones.wrapped.wrapped.pipe;
const [, ...addressConstraints] =
  updateContactBodySchema.entries.addresses.wrapped.wrapped.pipe;
const [, ...bankConstraints] =
  updateContactBodySchema.entries.bankAccounts.wrapped.wrapped.pipe;

/** Native input names map to the shared contact model only at this boundary. */
export const CONTACT_NESTED_INPUT_SCHEMAS = {
  emails: v.optional(
    v.nullable(v.pipe(v.array(emailInput), ...emailConstraints)),
  ),
  phones: v.optional(
    v.nullable(v.pipe(v.array(phoneInput), ...phoneConstraints)),
  ),
  addresses: v.optional(
    v.nullable(v.pipe(v.array(addressInput), ...addressConstraints)),
  ),
  metadata: v.optional(v.nullable(metadataInput)),
  bank_accounts: v.optional(
    v.nullable(v.pipe(v.array(bankInput), ...bankConstraints)),
  ),
  billing_address: v.optional(v.nullable(billingAddressInput)),
} as const;
