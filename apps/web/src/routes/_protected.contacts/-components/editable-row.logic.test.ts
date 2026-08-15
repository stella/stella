import { describe, expect, test } from "bun:test";

import {
  buildNumericContactPayload,
  buildTextContactPayload,
  getEditableFieldInputAttributes,
} from "@/routes/_protected.contacts/-components/editable-row.logic";

describe("contact numeric editable fields", () => {
  test("builds exact payloads for valid integers and clearing", () => {
    expect(buildNumericContactPayload("defaultHourlyRate", "0012")).toEqual({
      status: "valid",
      payload: { defaultHourlyRate: 12 },
    });
    expect(buildNumericContactPayload("defaultHourlyRate", "")).toEqual({
      status: "valid",
      payload: { defaultHourlyRate: null },
    });
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
    const numericFields = ["defaultHourlyRate", "paymentTermDays"] as const;
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
      inputMode: "numeric",
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
