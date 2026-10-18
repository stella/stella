import { describe, expect, test } from "bun:test";
import { decode as decodePayBySquare } from "bysquare/pay";

import { cents } from "@stll/money";

import {
  buildCzechQrPaymentPayload,
  buildPayBySquarePayload,
  paymentQrSchemeFor,
} from "./qr-payment";

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

const slovakIban = "SK27 1100 0000 1234 5678 9012";

describe("PAY by square payload", () => {
  test("matches a fixed encoded payment document", () => {
    const result = buildPayBySquarePayload({
      amount: 555.55,
      currency: "EUR",
      dueDate: "2026-10-14",
      variableSymbol: "2026001",
      paymentNote: "INV-2026-001",
      iban: slovakIban,
      bic: "FIKTSKBA",
      beneficiaryName: "Fiktívna kancelária, s. r. o.",
    }).unwrap();

    expect(result).toEqual({
      status: "payable",
      payload:
        "0807S00012G9GONTOS6FJAS8MPP9KSQJIB44LLS8QHAO1KB2ULONRPMOOAGQBT5QGAVI47VLTHQRT7CHCKHM29BL52F8JUG9BC83A9A6RK8M2IM1HRKKCCFR2BCC1JLI4CFJK9P5VNSV8C3TUL8K4BDJIF9IDOMNTI0TV018CO77KMAC2EG58QJFRVVU293G00",
    });
  });

  test("round-trips every supplied field, including beneficiary diacritics", () => {
    const payment = buildPayBySquarePayload({
      amount: 1234.56,
      currency: "eur",
      dueDate: "2027-02-28",
      variableSymbol: "0001234567",
      paymentNote: "FAKTÚRA-ŽLTÝ-KÔŇ",
      iban: slovakIban,
      bic: "fiktskba",
      beneficiaryName: "Žltá fiktívna spoločnosť",
    }).unwrap();
    if (payment.status !== "payable") {
      throw new Error("Fixture must produce a payable document");
    }

    expect(decodePayBySquare(payment.payload)).toEqual({
      payments: [
        {
          type: 1,
          amount: 1234.56,
          currencyCode: "EUR",
          paymentDueDate: "20270228",
          variableSymbol: "0001234567",
          paymentNote: "FAKTÚRA-ŽLTÝ-KÔŇ",
          bankAccounts: [{ iban: "SK2711000000123456789012", bic: "FIKTSKBA" }],
          beneficiary: {
            name: "Žltá fiktívna spoločnosť",
          },
        },
      ],
    });
  });

  test("rounds half cents to two decimals", () => {
    const payment = buildPayBySquarePayload({
      amount: 1.005,
      currency: "EUR",
      dueDate: "2026-10-14",
      variableSymbol: "1",
      paymentNote: "INV-1",
      iban: slovakIban,
      beneficiaryName: "Fiktívny príjemca",
    }).unwrap();
    if (payment.status !== "payable") {
      throw new Error("Fixture must produce a payable document");
    }
    expect(decodePayBySquare(payment.payload).payments.at(0)?.amount).toBe(
      1.01,
    );
  });

  test("clips long names and notes at their specification limits", () => {
    const payment = buildPayBySquarePayload({
      amount: 10,
      currency: "EUR",
      dueDate: "2026-10-14",
      variableSymbol: "1",
      paymentNote: "N".repeat(150),
      iban: slovakIban,
      beneficiaryName: `Ž${"x".repeat(80)}`,
    }).unwrap();
    if (payment.status !== "payable") {
      throw new Error("Fixture must produce a payable document");
    }
    const decoded = decodePayBySquare(payment.payload).payments.at(0);
    expect(Array.from(decoded?.beneficiary.name ?? "")).toHaveLength(70);
    expect(Array.from(decoded?.paymentNote ?? "")).toHaveLength(140);
  });

  test("refuses a checksum-invalid IBAN", () => {
    const result = buildPayBySquarePayload({
      amount: 10,
      currency: "EUR",
      dueDate: "2026-10-14",
      variableSymbol: "1",
      paymentNote: "INV-1",
      iban: "SK2811000000123456789012",
      beneficiaryName: "Fiktívny príjemca",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "PAY by square requires a valid IBAN checksum",
      );
    }
  });
});

describe("payment QR scheme", () => {
  test("maps account geography and currency exhaustively", () => {
    const cases = [
      [iban, "CZK", "spayd"],
      [iban, "EUR", "spayd"],
      [iban, "USD", null],
      [slovakIban, "EUR", "pay_by_square"],
      [slovakIban, "CZK", null],
      ["SK2811000000123456789012", "EUR", null],
    ] as const;
    for (const [account, currency, expected] of cases) {
      expect(paymentQrSchemeFor({ iban: account, currency })).toBe(expected);
    }
  });
});
