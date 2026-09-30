import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  isVatPeriodValid,
  MAX_VAT_RATE_BPS,
  parseVatRatePercent,
  vatRateFormSchema,
  vatRatePercentInput,
} from "./vat-rate-form.logic";

const schema = vatRateFormSchema({
  required: "Required",
  invalidField: "Invalid field",
  invalidRate: "Invalid rate",
  invalidPeriod: "Invalid period",
});
const raw = {
  code: " STANDARD ",
  name: " Standard VAT ",
  ratePercent: "21,25",
  validFrom: "2024-02-29",
  validTo: "",
} satisfies v.InferInput<typeof schema>;

describe("VAT percentage input", () => {
  test("maps decimal text to exact integer basis points", () => {
    for (const [text, expected] of [
      ["0", 0],
      ["0.01", 1],
      ["0,1", 10],
      ["21", 2100],
      [" 21,25 ", 2125],
      ["00021.20", 2120],
      ["21474836.47", MAX_VAT_RATE_BPS],
    ] as const) {
      expect(parseVatRatePercent(text)).toBe(expected);
    }
  });

  test("basis points round trip through both accepted decimal separators", () => {
    for (let rateBps = 0; rateBps <= 10_000; rateBps += 7) {
      const text = vatRatePercentInput(rateBps);
      expect(parseVatRatePercent(text)).toBe(rateBps);
      expect(parseVatRatePercent(text.replace(".", ","))).toBe(rateBps);
    }
    for (const rateBps of [
      10_001,
      999_999,
      MAX_VAT_RATE_BPS - 1,
      MAX_VAT_RATE_BPS,
    ]) {
      expect(parseVatRatePercent(vatRatePercentInput(rateBps))).toBe(rateBps);
    }
  });

  test("rejects malformed, excessive precision and out-of-range values", () => {
    for (const text of [
      "",
      " ",
      "-1",
      "+1",
      "1.001",
      "1,001",
      "1.",
      "1,",
      "1,000.00",
      "1e2",
      "NaN",
      "Infinity",
      "21474836.48",
      "999999999999999999999",
    ]) {
      expect(parseVatRatePercent(text)).toBeNull();
    }
  });
});

describe("VAT validity periods", () => {
  test("allows open periods and requires the exclusive end after the start", () => {
    expect(isVatPeriodValid({ validFrom: "2024-02-29", validTo: null })).toBe(
      true,
    );
    expect(
      isVatPeriodValid({ validFrom: "2024-02-29", validTo: "2024-03-01" }),
    ).toBe(true);
    expect(
      isVatPeriodValid({ validFrom: "2024-12-31", validTo: "2025-01-01" }),
    ).toBe(true);
    expect(
      isVatPeriodValid({ validFrom: "2024-02-29", validTo: "2024-02-29" }),
    ).toBe(false);
    expect(
      isVatPeriodValid({ validFrom: "2024-02-29", validTo: "2024-02-28" }),
    ).toBe(false);
  });

  test("rejects invalid calendar dates at either boundary", () => {
    for (const date of [
      "2025-02-29",
      "2024-04-31",
      "2024-13-01",
      "2024-2-01",
      "",
      "invalid",
    ]) {
      expect(isVatPeriodValid({ validFrom: date, validTo: null })).toBe(false);
      expect(isVatPeriodValid({ validFrom: "2024-01-01", validTo: date })).toBe(
        false,
      );
    }
  });
});

describe("VAT form normalization", () => {
  test("trims labels, parses the rate and clears the end date with null", () => {
    expect(v.parse(schema, raw)).toEqual({
      code: "STANDARD",
      name: "Standard VAT",
      rateBps: 2125,
      validFrom: "2024-02-29",
      validTo: null,
    });
    expect(
      v.parse(schema, { ...raw, ratePercent: "0", validTo: "2024-03-01" }),
    ).toEqual({
      code: "STANDARD",
      name: "Standard VAT",
      rateBps: 0,
      validFrom: "2024-02-29",
      validTo: "2024-03-01",
    });
  });

  test("rejects invalid numeric and period fields through the form schema", () => {
    expect(() => v.parse(schema, { ...raw, ratePercent: "21.001" })).toThrow(
      "Invalid rate",
    );
    expect(() => v.parse(schema, { ...raw, validFrom: "2025-02-29" })).toThrow(
      "Invalid period",
    );
    expect(() => v.parse(schema, { ...raw, validTo: raw.validFrom })).toThrow(
      "Invalid period",
    );
    expect(() => v.parse(schema, { ...raw, code: " " })).toThrow("Required");
    expect(() => v.parse(schema, { ...raw, name: " " })).toThrow("Required");
    expect(() => v.parse(schema, { ...raw, code: "x".repeat(65) })).toThrow(
      "Invalid field",
    );
    expect(() => v.parse(schema, { ...raw, name: "x".repeat(129) })).toThrow(
      "Invalid field",
    );
  });
});
