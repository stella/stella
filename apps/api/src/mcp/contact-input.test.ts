import { expect, test } from "bun:test";
import * as v from "valibot";

import { updateContactBodySchema } from "@stll/api-contract/contact-write";

import { CONTACT_NESTED_INPUT_SCHEMAS } from "@/api/mcp/contact-input";

const CONTACT_INPUT = v.strictObject(CONTACT_NESTED_INPUT_SCHEMAS);

test("nested contact wire fields map to the canonical contact model", () => {
  const input = {
    emails: [{ type: "work", address: "Name@example.com", is_primary: true }],
    phones: [{ type: "mobile", number: "+420123456789", is_primary: false }],
    addresses: [
      {
        type: "office",
        line1: "Street",
        postal_code: "12345",
        is_primary: true,
      },
    ],
    metadata: {
      data_boxes: [{ id: "aB12cD3", is_primary: true }],
      custom_fields: [{ id: "reference", label: "Reference", value: "123" }],
    },
    bank_accounts: [
      { account_number: "123456", bank_name: "Bank", currency: "eur" },
    ],
    billing_address: { postal_code: "23456" },
  };
  const parsed = v.parse(CONTACT_INPUT, input);
  expect(parsed).toEqual({
    emails: [{ type: "work", address: "Name@example.com", isPrimary: true }],
    phones: [{ type: "mobile", number: "+420123456789", isPrimary: false }],
    addresses: [
      { type: "office", line1: "Street", postalCode: "12345", isPrimary: true },
    ],
    metadata: {
      dataBoxes: [{ id: "aB12cD3", isPrimary: true }],
      customFields: [{ id: "reference", label: "Reference", value: "123" }],
    },
    bank_accounts: [
      { accountNumber: "123456", bankName: "Bank", currency: "EUR" },
    ],
    billing_address: { postalCode: "23456" },
  });
  const { bank_accounts, billing_address, ...fields } = parsed;
  const canonical = {
    ...fields,
    bankAccounts: bank_accounts,
    billingAddress: billing_address,
  };
  expect(v.parse(updateContactBodySchema, canonical)).toEqual(canonical);
});

test("nested contact inputs reject unknown properties at every object boundary", () => {
  const inputs = [
    {
      emails: [
        {
          type: "work",
          address: "name@example.com",
          is_primary: true,
          isPrimary: true,
        },
      ],
    },
    {
      phones: [{ type: "office", number: "123", is_primary: true, typo: true }],
    },
    {
      addresses: [
        {
          type: "office",
          line1: "Street",
          is_primary: true,
          postalCode: "123",
        },
      ],
    },
    { metadata: { dataBoxes: [] } },
    {
      metadata: {
        data_boxes: [{ id: "aB12cD3", is_primary: true, typo: true }],
      },
    },
    {
      metadata: {
        custom_fields: [
          { id: "key", label: "Key", value: "Value", typo: true },
        ],
      },
    },
    { bank_accounts: [{ accountNumbr: "123" }] },
    { billing_address: { postalCode: "123" } },
  ];
  for (const input of inputs) {
    const parsed = v.safeParse(CONTACT_INPUT, input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.type)).toContain(
        "strict_object",
      );
    }
  }
});
