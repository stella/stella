import { describe, expect, test } from "bun:test";

import {
  buildContactRatePayload,
  buildNumericContactPayload,
  contactRateInput,
  buildTextContactPayload,
  getEditableFieldInputAttributes,
} from "@/routes/_protected.contacts/-components/editable-row.logic";

describe("contact numeric editable fields", () => {
  test("builds exact payloads for valid integers and clearing", () => {
    expect(buildNumericContactPayload("paymentTermDays", "0")).toEqual({
      status: "valid",
      payload: { paymentTermDays: 0 },
    });
    expect(buildNumericContactPayload("paymentTermDays", "365")).toEqual({
      status: "valid",
      payload: { paymentTermDays: 365 },
    });
    expect(buildNumericContactPayload("paymentTermDays", "")).toEqual({
      status: "valid",
      payload: { paymentTermDays: null },
    });
  });

  test("rejects partial, non-integer, negative, unsafe, and out-of-range tokens", () => {
    const numericFields = ["paymentTermDays"] as const;
    const invalidInputs = [
      "12oops",
      "1e3",
      "12.5",
      "-1",
      "+12",
      "9007199254740992",
    ];

    for (const field of numericFields) {
      for (const input of invalidInputs) {
        expect(buildNumericContactPayload(field, input)).toEqual({
          status: "invalid",
        });
      }
    }

    expect(buildNumericContactPayload("paymentTermDays", "366")).toEqual({
      status: "invalid",
    });
  });

  test("preserves raw numeric tokens for validation", () => {
    expect(getEditableFieldInputAttributes("defaultHourlyRate")).toEqual({
      type: "text",
      inputMode: "decimal",
    });
    expect(getEditableFieldInputAttributes("paymentTermDays")).toEqual({
      type: "text",
      inputMode: "numeric",
    });
  });
});

describe("contact text editable fields", () => {
  test("maps every field to its exact API property", () => {
    expect([
      buildTextContactPayload("prefix", "Dr"),
      buildTextContactPayload("firstName", "Ada"),
      buildTextContactPayload("middleName", "M"),
      buildTextContactPayload("lastName", "Lovelace"),
      buildTextContactPayload("suffix", "KC"),
      buildTextContactPayload("organizationName", "Analytical Engines"),
      buildTextContactPayload("displayName", "Ada Lovelace"),
      buildTextContactPayload("notes", "Counsel"),
      buildTextContactPayload("registrationNumber", "123"),
      buildTextContactPayload("taxId", "GB123"),
      buildTextContactPayload("currency", "GBP"),
    ]).toEqual([
      { prefix: "Dr" },
      { firstName: "Ada" },
      { middleName: "M" },
      { lastName: "Lovelace" },
      { suffix: "KC" },
      { organizationName: "Analytical Engines" },
      { displayName: "Ada Lovelace" },
      { notes: "Counsel" },
      { registrationNumber: "123" },
      { taxId: "GB123" },
      { currency: "GBP" },
    ]);
  });

  test("clears every optional text field with null", () => {
    expect([
      buildTextContactPayload("prefix", ""),
      buildTextContactPayload("firstName", ""),
      buildTextContactPayload("middleName", ""),
      buildTextContactPayload("lastName", ""),
      buildTextContactPayload("suffix", ""),
      buildTextContactPayload("organizationName", ""),
      buildTextContactPayload("notes", ""),
      buildTextContactPayload("registrationNumber", ""),
      buildTextContactPayload("taxId", ""),
      buildTextContactPayload("currency", ""),
    ]).toEqual([
      { prefix: null },
      { firstName: null },
      { middleName: null },
      { lastName: null },
      { suffix: null },
      { organizationName: null },
      { notes: null },
      { registrationNumber: null },
      { taxId: null },
      { currency: null },
    ]);
  });
});

describe("contact hourly rates", () => {
  for (const { currency, text, minorUnits, zeroText } of [
    { currency: "EUR", text: "150.50", minorUnits: 15_050, zeroText: "0.00" },
    { currency: "JPY", text: "150", minorUnits: 150, zeroText: "0" },
    {
      currency: "KWD",
      text: "150.500",
      minorUnits: 150_500,
      zeroText: "0.000",
    },
  ]) {
    test(`${currency} displays and saves major units`, () => {
      const displayed = contactRateInput(minorUnits, currency);
      expect(displayed).toBe(text);
      expect(
        buildContactRatePayload({ trimmedInput: displayed ?? "", currency }),
      ).toEqual({
        status: "valid",
        payload: { defaultHourlyRate: minorUnits },
      });
      expect(contactRateInput(0, currency)).toBe(zeroText);
    });
  }

  test("requires currency for a nonempty rate and allows clearing", () => {
    expect(contactRateInput(15_050, null)).toBeNull();
    expect(contactRateInput(null, "EUR")).toBeNull();
    expect(
      buildContactRatePayload({ trimmedInput: "150.50", currency: null }),
    ).toEqual({ status: "invalid" });
    for (const currency of [null, "EUR", "JPY", "KWD"]) {
      expect(buildContactRatePayload({ trimmedInput: "", currency })).toEqual({
        status: "valid",
        payload: { defaultHourlyRate: null },
      });
    }
  });

  test("refuses invalid, negative and unsafe amounts", () => {
    for (const trimmedInput of [
      "oops",
      "12oops",
      "-1",
      "9007199254740992",
      "Infinity",
    ]) {
      expect(
        buildContactRatePayload({ trimmedInput, currency: "EUR" }),
      ).toEqual({ status: "invalid" });
    }
  });
});
