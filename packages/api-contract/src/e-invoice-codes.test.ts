import { describe, expect, test } from "bun:test";

import {
  eInvoiceIdentifierScheme,
  eInvoiceQuantityCount,
  eInvoiceUnit,
  isVatAddressScheme,
} from "./e-invoice-codes";

describe("eInvoiceUnit", () => {
  test.each([
    ["C62", { type: "named", name: "unit" }],
    ["H87", { type: "named", name: "unit" }],
    ["HUR", { type: "named", name: "hour" }],
    ["day", { type: "named", name: "day" }],
    ["MON", { type: "named", name: "month" }],
    ["KGM", { type: "symbol", symbol: "kg" }],
    ["MTK", { type: "symbol", symbol: "m²" }],
    ["MTR", { type: "symbol", symbol: "m" }],
  ] as const)("names %s", (code, unit) => {
    expect(eInvoiceUnit(code)).toEqual(unit);
  });

  test("keeps a code no list names as the file writes it", () => {
    expect(eInvoiceUnit("ks")).toEqual({ type: "code", code: "ks" });
    expect(eInvoiceUnit("XPK")).toEqual({ type: "code", code: "XPK" });
    expect(eInvoiceUnit("constructor")).toEqual({
      type: "code",
      code: "constructor",
    });
  });
});

describe("eInvoiceQuantityCount", () => {
  test.each([
    ["14", 14],
    ["1", 1],
    ["0.5", 0.5],
    [" 32 ", 32],
    ["-2", -2],
  ] as const)("reads %p as %p", (literal, count) => {
    expect(eInvoiceQuantityCount(literal)).toBe(count);
  });

  test.each(["1,5", "1e3", "", "dvě", "0x10", ".25", "+2"])(
    "does not read %p as a number",
    (literal) => {
      expect(eInvoiceQuantityCount(literal)).toBeNull();
    },
  );
});

describe("identifier schemes", () => {
  test("a VAT or tax id needs no scheme beside its kind", () => {
    for (const scheme of ["VAT", "VA", "IdFiscaleIVA", "9944", null]) {
      expect(eInvoiceIdentifierScheme({ kind: "vat", scheme })).toEqual({
        type: "none",
      });
    }
    expect(eInvoiceIdentifierScheme({ kind: "tax", scheme: "FC" })).toEqual({
      type: "none",
    });
  });

  test("names a known ISO 6523 scheme and keeps an unknown code", () => {
    expect(eInvoiceIdentifierScheme({ kind: "other", scheme: "0088" })).toEqual(
      { type: "named", name: "GLN" },
    );
    expect(
      eInvoiceIdentifierScheme({ kind: "registration", scheme: "0106" }),
    ).toEqual({ type: "named", name: "KvK" });
    expect(eInvoiceIdentifierScheme({ kind: "other", scheme: "0999" })).toEqual(
      { type: "code", code: "0999" },
    );
    expect(eInvoiceIdentifierScheme({ kind: "other", scheme: null })).toEqual({
      type: "none",
    });
  });

  test("tells VAT electronic address schemes from the others", () => {
    for (const scheme of ["9929", "9944", "9950", "9930", "0211", "9957"]) {
      expect(isVatAddressScheme(scheme)).toBeTrue();
    }
    for (const scheme of ["0088", "0208", "9918", "9921", "9954", null]) {
      expect(isVatAddressScheme(scheme)).toBeFalse();
    }
  });
});
