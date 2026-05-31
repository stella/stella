import { describe, expect, test } from "bun:test";

import { parseValidation } from "./parse.js";
import type { ViesRawResponse, ViesVatNumber } from "./types.js";

const VAT_NUMBER: ViesVatNumber = { country: "IE", vat: "6388047V" };

const baseRaw = (overrides: Partial<ViesRawResponse>): ViesRawResponse => ({
  isValid: false,
  requestDate: "2026-05-31T00:00:00.000Z",
  userError: "INVALID",
  name: "---",
  address: "---",
  requestIdentifier: "",
  originalVatNumber: "6388047V",
  vatNumber: "6388047V",
  ...overrides,
});

describe("parseValidation", () => {
  test("maps a VALID response to status.valid", () => {
    const out = parseValidation(
      baseRaw({
        isValid: true,
        userError: "VALID",
        name: "GOOGLE IRELAND LIMITED",
        address: "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
      }),
      VAT_NUMBER,
    );
    expect(out.valid).toBe(true);
    expect(out.status).toEqual({ type: "valid" });
    expect(out.name).toBe("GOOGLE IRELAND LIMITED");
    expect(out.address).toBe(
      "3RD FLOOR, GORDON HOUSE, BARROW STREET, DUBLIN 4",
    );
    expect(out.vatNumber).toEqual(VAT_NUMBER);
  });

  test("collapses '---' sentinel name/address to null", () => {
    const out = parseValidation(
      baseRaw({ isValid: true, userError: "VALID" }),
      VAT_NUMBER,
    );
    expect(out.valid).toBe(true);
    expect(out.name).toBeNull();
    expect(out.address).toBeNull();
  });

  test("INVALID maps to not-registered", () => {
    const out = parseValidation(baseRaw({ userError: "INVALID" }), VAT_NUMBER);
    expect(out.valid).toBe(false);
    expect(out.status).toEqual({ type: "not-registered" });
  });

  test("INVALID_INPUT maps to invalid-format", () => {
    const out = parseValidation(
      baseRaw({ userError: "INVALID_INPUT" }),
      VAT_NUMBER,
    );
    expect(out.valid).toBe(false);
    expect(out.status).toEqual({ type: "invalid-format" });
  });

  test("SERVICE_UNAVAILABLE family maps to service-unavailable", () => {
    for (const userError of [
      "SERVICE_UNAVAILABLE",
      "MS_UNAVAILABLE",
      "TIMEOUT",
      "MS_MAX_CONCURRENT_REQ",
    ]) {
      const out = parseValidation(baseRaw({ userError }), VAT_NUMBER);
      expect(out.valid).toBe(false);
      expect(out.status).toEqual({ type: "service-unavailable", userError });
    }
  });

  test("unknown userError values collapse to not-registered (safe default)", () => {
    const out = parseValidation(
      baseRaw({ userError: "SOMETHING_NEW_FROM_UPSTREAM" }),
      VAT_NUMBER,
    );
    expect(out.valid).toBe(false);
    expect(out.status).toEqual({ type: "not-registered" });
  });

  test("preserves requestDate", () => {
    const out = parseValidation(
      baseRaw({ requestDate: "2026-01-15T10:30:00.000Z" }),
      VAT_NUMBER,
    );
    expect(out.requestDate).toBe("2026-01-15T10:30:00.000Z");
  });
});
