import { describe, expect, test } from "bun:test";
import { decode as decodePayBySquare } from "bysquare/pay";
import { decompress } from "lzma1";

import { cents } from "@stll/money";

import { buildPayBySquarePayload } from "./pay-by-square";

const iban = "SK96 1100 0000 0029 1859 9669";
const BASE32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

// An independent reading of the QR string, the way a banking app decodes it:
// base32hex, the 2-byte header, the payload length, the LZMA body behind a
// rebuilt stream header (lc=3 lp=0 pb=2, 2^17 dictionary), then the CRC32 in
// front of the tab-separated data model.
const decode = (payload: string) => {
  const bits = Array.from(payload, (character) => {
    const value = BASE32HEX.indexOf(character);
    expect(value).toBeGreaterThanOrEqual(0);
    return value.toString(2).padStart(5, "0");
  }).join("");
  const framed = Uint8Array.from(
    { length: Math.floor(bits.length / 8) },
    (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2),
  );
  const view = new DataView(framed.buffer);
  const length = view.getUint16(2, true);
  const streamHeader = new Uint8Array(13);
  streamHeader[0] = 0x5d;
  new DataView(streamHeader.buffer).setUint32(1, 131_072, true);
  new DataView(streamHeader.buffer).setUint32(5, length, true);
  const checked = decompress(
    Uint8Array.from([...streamHeader, ...framed.subarray(4)]),
  );
  expect(checked.length).toBe(length);
  const text = checked.subarray(4);
  return {
    header: [framed[0], framed[1]],
    crcMatches:
      new DataView(checked.buffer, checked.byteOffset).getUint32(0, true) ===
      Bun.hash.crc32(text),
    fields: new TextDecoder().decode(text).split("\t"),
  };
};

const payable = (payload: ReturnType<typeof buildPayBySquarePayload>) => {
  const result = payload.unwrap();
  if (result.status !== "payable") {
    throw new Error(`Expected a payable result, got ${result.status}`);
  }
  return decode(result.payload);
};

describe("PAY by square payload", () => {
  test("checksums with the standard IEEE CRC32", () => {
    // The CRC-32 check value: the encoder's checksum is this function.
    expect(Bun.hash.crc32("123456789")).toBe(0xcb_f4_39_26);
  });

  test("encodes one payment order in the version 1.2.0 data model", () => {
    const decoded = payable(
      buildPayBySquarePayload({
        documentType: "invoice",
        iban,
        bic: "tatr skbx",
        amountMinor: cents(263_000),
        currency: "eur",
        variableSymbol: "20250003",
        dueDate: "2025-04-15",
        message: "FA-2025-0003",
        beneficiaryName: "Hrabovský & Partneri, s.r.o.",
      }),
    );

    expect(decoded.header).toEqual([0x02, 0x00]);
    expect(decoded.crcMatches).toBe(true);
    expect(decoded.fields).toEqual([
      "",
      "1",
      "1",
      "2630.00",
      "EUR",
      "20250415",
      "20250003",
      "",
      "",
      "",
      "FA-2025-0003",
      "1",
      "SK9611000000002918599669",
      "TATRSKBX",
      "0",
      "0",
      "Hrabovský & Partneri, s.r.o.",
      "",
      "",
    ]);
  });

  test("leaves optional fields empty and drops a malformed BIC", () => {
    const decoded = payable(
      buildPayBySquarePayload({
        documentType: "advance",
        iban,
        bic: "not a bic",
        amountMinor: cents(1),
        currency: "EUR",
        beneficiaryName: "Bednár",
      }),
    );

    expect(decoded.fields.slice(3, 14)).toEqual([
      "0.01",
      "EUR",
      "",
      "",
      "",
      "",
      "",
      "",
      "1",
      "SK9611000000002918599669",
      "",
    ]);
    expect(decoded.fields.at(-3)).toBe("Bednár");
  });

  test("preserves diacritics while replacing tabs and clipping free text", () => {
    const decoded = payable(
      buildPayBySquarePayload({
        documentType: "invoice",
        iban,
        amountMinor: cents(100),
        currency: "EUR",
        message: `Úhrada\tfaktúry ${"č".repeat(200)}`,
        beneficiaryName: `Ľubica\tŠťastná ${"ž".repeat(100)}`,
      }),
    );

    const note = decoded.fields[10] ?? "";
    const name = decoded.fields.at(-3) ?? "";
    expect(note.startsWith("Úhrada faktúry č")).toBe(true);
    expect(note.length).toBe(140);
    expect(name.startsWith("Ľubica Šťastná ž")).toBe(true);
    expect(name.length).toBe(70);
    expect(decoded.fields).toHaveLength(19);
  });

  test("does not ask for payment of a credit note", () => {
    expect(
      buildPayBySquarePayload({
        documentType: "credit_note",
        iban,
        amountMinor: cents(100),
        currency: "EUR",
        beneficiaryName: "Bednár",
      }).unwrap(),
    ).toEqual({ status: "not_payable", reason: "credit_note" });
  });

  test.each([
    [
      { amountMinor: cents(0) },
      "QR payment amount must be a positive minor amount",
    ],
    [{ currency: "EURO" }, "QR payment requires an ISO currency code"],
    [
      { iban: "SK96 1100 0000 0029 1859 9668" },
      "QR payment requires a valid IBAN checksum",
    ],
    [
      { variableSymbol: "12345678901" },
      "Variable symbol must contain 1 to 10 digits",
    ],
    [
      { dueDate: "2025-02-29" },
      "QR payment due date must be a real calendar date",
    ],
    [{ beneficiaryName: " \t " }, "PAY by square requires a beneficiary name"],
  ] as const)("refuses invalid input %#", (override, message) => {
    const result = buildPayBySquarePayload({
      documentType: "invoice",
      iban,
      amountMinor: cents(100),
      currency: "EUR",
      beneficiaryName: "Bednár",
      ...override,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(message);
    }
  });
});

describe("PAY by square independent decoder compatibility", () => {
  test("matches the fields of a fixed independently encoded payment", () => {
    const result = buildPayBySquarePayload({
      documentType: "invoice",
      amountMinor: cents(55_555),
      currency: "EUR",
      dueDate: "2026-10-14",
      variableSymbol: "2026001",
      message: "INV-2026-001",
      iban: "SK2711000000123456789012",
      bic: "FIKTSKBA",
      beneficiaryName: "Fiktívna kancelária, s. r. o.",
    }).unwrap();
    if (result.status !== "payable") {
      throw new Error("Fixture is payable");
    }
    const golden =
      "0807S00012G9GONTOS6FJAS8MPP9KSQJIB44LLS8QHAO1KB2ULONRPMOOAGQBT5QGAVI47VLTHQRT7CHCKHM29BL52F8JUG9BC83A9A6RK8M2IM1HRKKCCFR2BCC1JLI4CFJK9P5VNSV8C3TUL8K4BDJIF9IDOMNTI0TV018CO77KMAC2EG58QJFRVVU293G00";
    expect(decodePayBySquare(result.payload)).toEqual(
      decodePayBySquare(golden),
    );
  });

  test("normalizes decomposed UTF-8 and clips by code points without splitting characters", () => {
    const result = buildPayBySquarePayload({
      documentType: "invoice",
      amountMinor: cents(123_456),
      currency: "eur",
      dueDate: "2027-02-28",
      variableSymbol: "0001234567",
      message: `FAKTÚRA-ŽLTÝ-KÔŇ ${"🦉".repeat(150)}`,
      iban: "SK2711000000123456789012",
      bic: "fiktskba",
      beneficiaryName: `Z\u030clta\u0301 fiktívna spoločnosť ${"🦉".repeat(80)}`,
    }).unwrap();
    if (result.status !== "payable") {
      throw new Error("Fixture is payable");
    }
    const payment = decodePayBySquare(result.payload).payments.at(0);
    expect(payment).toMatchObject({
      amount: 1234.56,
      currencyCode: "EUR",
      paymentDueDate: "20270228",
      variableSymbol: "0001234567",
      bankAccounts: [{ iban: "SK2711000000123456789012", bic: "FIKTSKBA" }],
    });
    expect(
      payment?.beneficiary.name.startsWith("Žltá fiktívna spoločnosť"),
    ).toBe(true);
    expect(payment?.paymentNote?.startsWith("FAKTÚRA-ŽLTÝ-KÔŇ")).toBe(true);
    expect(Array.from(payment?.beneficiary.name ?? "")).toHaveLength(70);
    expect(Array.from(payment?.paymentNote ?? "")).toHaveLength(140);
    expect(payment?.beneficiary.name).not.toContain("\uFFFD");
  });
});
