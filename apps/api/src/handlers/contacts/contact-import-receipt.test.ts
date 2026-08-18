import { describe, expect, test } from "bun:test";

import {
  classifyBrazilianTaxId,
  fingerprintContactImport,
} from "./contact-import-receipt";

describe("contact import receipt", () => {
  test("classifies checksum-valid CPF and CNPJ values", () => {
    expect(classifyBrazilianTaxId("123.456.789-09")).toEqual({
      digits: "12345678909",
      type: "person",
    });
    expect(classifyBrazilianTaxId("11.222.333/0001-81")).toEqual({
      digits: "11222333000181",
      type: "organization",
    });
    expect(classifyBrazilianTaxId("123.456.789-00")).toBeNull();
  });

  test("is a fixed point for retries and changes with semantic payload", () => {
    const rows = [{ id: "one", displayName: "Maria", taxId: "12345678909" }];

    expect(fingerprintContactImport(rows)).toBe(fingerprintContactImport(rows));
    expect(fingerprintContactImport(rows)).not.toBe(
      fingerprintContactImport([{ ...rows[0], displayName: "Mariana" }]),
    );
  });

  test("ignores property order and absent optionals", () => {
    const rows = [
      {
        id: "one",
        displayName: "Maria",
        emails: [{ address: "m@example.com", type: "work", isPrimary: true }],
        notes: undefined,
      },
    ];
    const reordered = [
      {
        emails: [{ isPrimary: true, type: "work", address: "m@example.com" }],
        displayName: "Maria",
        id: "one",
      },
    ];

    // The fixture must differ textually, or the equality proves nothing.
    expect(JSON.stringify(rows)).not.toBe(JSON.stringify(reordered));
    expect(fingerprintContactImport(rows)).toBe(
      fingerprintContactImport(reordered),
    );
  });
});
