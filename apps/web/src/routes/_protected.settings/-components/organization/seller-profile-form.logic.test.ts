import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  SELLER_PROFILE_FIELDS,
  sellerProfileFormSchema,
} from "./seller-profile-form.logic";

const schema = sellerProfileFormSchema({
  required: "Required",
  invalidField: "Invalid field",
  invalidIban: "Invalid IBAN",
  invalidBic: "Invalid BIC",
  invalidCurrency: "Invalid currency",
});
const empty = {
  legalName: "  Legal Practice  ",
  registrationId: "",
  vatId: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  postalCode: "",
  country: "",
  iban: "",
  bic: "",
  accountNumber: "",
  defaultCurrency: " eur ",
  footerNotes: "",
} satisfies v.InferInput<typeof schema>;

describe("seller profile form normalization", () => {
  test("trims required fields and omits cleared optional fields from the request", () => {
    const values = v.parse(schema, empty);
    expect(values).toEqual({
      legalName: "Legal Practice",
      defaultCurrency: "EUR",
    });
    expect(Object.keys(values).toSorted()).toEqual([
      "defaultCurrency",
      "legalName",
    ]);
    for (const name of SELLER_PROFILE_FIELDS) {
      expect(Object.hasOwn(values, name)).toBe(
        name === "legalName" || name === "defaultCurrency",
      );
    }
  });

  test("normalizes payment details and trims optional text without changing account numbers", () => {
    const values = v.parse(schema, {
      ...empty,
      registrationId: " 001234 ",
      vatId: " CZ001234 ",
      addressLine1: " First street ",
      addressLine2: " Floor 2 ",
      city: " Prague ",
      postalCode: " 110 00 ",
      country: " CZ ",
      iban: "cz33 0100 0000 0000 0297 0297",
      bic: " kombczpp ",
      accountNumber: " 000123/0100 ",
      footerNotes: " Payment within 14 days. ",
    });
    expect(values).toEqual({
      legalName: "Legal Practice",
      defaultCurrency: "EUR",
      registrationId: "001234",
      vatId: "CZ001234",
      addressLine1: "First street",
      addressLine2: "Floor 2",
      city: "Prague",
      postalCode: "110 00",
      country: "CZ",
      iban: "CZ3301000000000002970297",
      bic: "KOMBCZPP",
      accountNumber: "000123/0100",
      footerNotes: "Payment within 14 days.",
    });
  });

  test("clears whitespace-only optional values", () => {
    for (const name of SELLER_PROFILE_FIELDS) {
      if (name === "legalName" || name === "defaultCurrency") {
        continue;
      }
      const result = v.parse(schema, { ...empty, [name]: "  \n " });
      expect(result).toEqual({
        legalName: "Legal Practice",
        defaultCurrency: "EUR",
      });
      expect(Object.hasOwn(result, name)).toBe(false);
      expect(Object.keys(result).toSorted()).toEqual([
        "defaultCurrency",
        "legalName",
      ]);
    }
  });

  test("rejects invalid IBAN checksum, BIC format, currency and blank legal name", () => {
    expect(() =>
      v.parse(schema, { ...empty, iban: "CZ3401000000000002970297" }),
    ).toThrow("Invalid IBAN");
    expect(() => v.parse(schema, { ...empty, bic: "not-a-bic" })).toThrow(
      "Invalid BIC",
    );
    for (const currency of ["EU", "EURO", "12X", ""]) {
      expect(() =>
        v.parse(schema, { ...empty, defaultCurrency: currency }),
      ).toThrow("Invalid currency");
    }
    expect(() => v.parse(schema, { ...empty, legalName: "  " })).toThrow(
      "Required",
    );
  });
});
