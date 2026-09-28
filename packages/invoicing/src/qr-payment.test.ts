import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { buildCzechQrPaymentPayload } from "./qr-payment";

const iban = "CZ33 0100 0000 0000 0297 0297";

describe("Czech payment payload", () => {
  test("uses the QR Platba example account and encodes payment fields", () => {
    expect(
      buildCzechQrPaymentPayload({
        documentType: "invoice",
        iban,
        amountMinor: cents(55_555),
        currency: "CZK",
        variableSymbol: "0987654321",
        dueDate: "2021-04-30",
        message: "PRISPEVEK NA NADACI",
      }).unwrap(),
    ).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:555.55*CC:CZK*X-VS:0987654321*DT:20210430*MSG:PRISPEVEK NA NADACI",
    });
  });

  test("uses each currency's exponent and escapes free text delimiters", () => {
    const payment = {
      documentType: "advance" as const,
      iban,
      amountMinor: cents(1234),
      message: "Part * two % done",
    };

    expect(
      buildCzechQrPaymentPayload({ ...payment, currency: "JPY" }).unwrap(),
    ).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:1234*CC:JPY*MSG:Part %2A two %25 done",
    });
    expect(
      buildCzechQrPaymentPayload({ ...payment, currency: "KWD" }).unwrap(),
    ).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:1.234*CC:KWD*MSG:Part %2A two %25 done",
    });
  });

  test("returns a typed non-payable result for a credit note", () => {
    expect(
      buildCzechQrPaymentPayload({
        documentType: "credit_note",
        iban,
        amountMinor: cents(-55_555),
        currency: "CZK",
      }).unwrap(),
    ).toEqual({ status: "not_payable", reason: "credit_note" });
  });

  test("limits encoded message length without splitting an escape", () => {
    const result = buildCzechQrPaymentPayload({
      documentType: "invoice",
      iban,
      amountMinor: cents(100),
      currency: "CZK",
      message: "*".repeat(21),
    }).unwrap();

    expect(result).toEqual({
      status: "payable",
      payload: `SPD*1.0*ACC:CZ3301000000000002970297*AM:1.00*CC:CZK*MSG:${"%2A".repeat(20)}`,
    });
  });

  test("rejects a checksum-invalid IBAN", () => {
    const result = buildCzechQrPaymentPayload({
      documentType: "invoice",
      iban: "CZ3401000000000002970297",
      amountMinor: cents(100),
      currency: "CZK",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "QR payment requires a valid IBAN checksum",
      );
    }
  });

  test("rejects variable symbols that would change during normalization", () => {
    for (const variableSymbol of ["", "12A34", "12345678901"]) {
      const result = buildCzechQrPaymentPayload({
        documentType: "invoice",
        iban,
        amountMinor: cents(100),
        currency: "CZK",
        variableSymbol,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          "Variable symbol must contain 1 to 10 digits",
        );
      }
    }
  });

  test("rejects impossible due dates and accepts a leap day", () => {
    const payment = {
      documentType: "invoice" as const,
      iban,
      amountMinor: cents(100),
      currency: "CZK",
    };
    for (const dueDate of ["2026-02-31", "2026-99-99"]) {
      const result = buildCzechQrPaymentPayload({ ...payment, dueDate });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          "QR payment due date must be a real calendar date",
        );
      }
    }
    expect(
      buildCzechQrPaymentPayload({
        ...payment,
        dueDate: "2024-02-29",
      }).unwrap(),
    ).toEqual({
      status: "payable",
      payload:
        "SPD*1.0*ACC:CZ3301000000000002970297*AM:1.00*CC:CZK*DT:20240229",
    });
  });

  test("rejects unsupported currency codes", () => {
    const result = buildCzechQrPaymentPayload({
      documentType: "invoice",
      iban,
      amountMinor: cents(100),
      currency: "ZZZ",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "QR payment requires an ISO currency code",
      );
    }
  });
});
