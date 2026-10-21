import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { buildPolishQrPaymentPayload } from "./polish-qr-payment";

// The recommendation's example account (section 3.1) as an IBAN, and a NIP
// with a valid checksum in place of its placeholder 1234567890.
const payment = {
  documentType: "invoice" as const,
  iban: "PL92 1240 1234 0001 5678 9012 3456",
  amountMinor: cents(1200),
  currency: "PLN",
  recipientNip: "526-000-12-46",
  recipientName: "Odbiorca 1",
  title: "FV 1234/34/2012",
};

describe("Polish ZBP payment payload", () => {
  test("matches the recommendation's example for an institutional payee", () => {
    expect(buildPolishQrPaymentPayload(payment).unwrap()).toEqual({
      status: "payable",
      payload:
        "5260001246|PL|92124012340001567890123456|001200|Odbiorca 1|FV 1234/34/2012|||",
    });
  });

  test("pads the amount to six digits and lets larger amounts grow", () => {
    const payloadFor = (amountMinor: number) => {
      const result = buildPolishQrPaymentPayload({
        ...payment,
        amountMinor: cents(amountMinor),
      }).unwrap();
      return result.status === "payable" ? result.payload.split("|")[3] : "";
    };
    expect(payloadFor(1)).toBe("000001");
    expect(payloadFor(1012)).toBe("001012");
    expect(payloadFor(123_456_789)).toBe("123456789");
  });

  test("keeps Polish letters, drops other marks and the separator, and truncates", () => {
    const result = buildPolishQrPaymentPayload({
      ...payment,
      recipientName: "Kancelaria Śląska | Ján   Novák",
      title: `Faktura ${"ż".repeat(40)}`,
    }).unwrap();
    expect(result.status).toBe("payable");
    const fields = result.status === "payable" ? result.payload.split("|") : [];
    expect(fields).toHaveLength(9);
    expect(fields[4]).toBe("Kancelaria Śląska Ja");
    expect(fields[5]).toBe(`Faktura ${"ż".repeat(24)}`);
    expect(fields[5]).toHaveLength(32);
  });

  test("does not ask for payment of a credit note or in a foreign currency", () => {
    expect(
      buildPolishQrPaymentPayload({
        ...payment,
        documentType: "credit_note",
      }).unwrap(),
    ).toEqual({ status: "not_payable", reason: "credit_note" });
    expect(
      buildPolishQrPaymentPayload({ ...payment, currency: "EUR" }).unwrap(),
    ).toEqual({ status: "not_payable", reason: "not_pln" });
  });

  test.each([
    [{ recipientNip: "5260001247" }, "Polish QR payment requires a valid NIP"],
    [
      { iban: "SK96 1100 0000 0029 1859 9669" },
      "Polish QR payment requires a Polish IBAN",
    ],
    [
      { iban: "PL92 1240 1234 0001 5678 9012 3457" },
      "QR payment requires a valid IBAN checksum",
    ],
    [{ recipientName: " | " }, "Polish QR payment requires a payee name"],
    [{ title: "\t" }, "Polish QR payment requires a payment title"],
    [
      { amountMinor: cents(0) },
      "QR payment amount must be a positive minor amount",
    ],
  ] as const)("refuses invalid input %#", (override, message) => {
    const result = buildPolishQrPaymentPayload({ ...payment, ...override });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(message);
    }
  });
});
