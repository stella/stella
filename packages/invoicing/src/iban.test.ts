import { describe, expect, test } from "bun:test";

import { normalizeIban, parseIban } from "./iban";

describe("IBAN normalization", () => {
  test("uppercases and removes formatting whitespace", () => {
    expect(normalizeIban("cz33 0100 0000 0000 0297 0297")).toBe(
      "CZ3301000000000002970297",
    );
  });

  test("checks the country-specific length before accepting the checksum", () => {
    expect(normalizeIban("CZ330100000000000297029")).toBeNull();
    expect(normalizeIban("DE8937040044053201300")).toBeNull();
    expect(normalizeIban("CZ3301000000000002970297")).toBe(
      "CZ3301000000000002970297",
    );
  });

  test("rejects an invalid MOD 97 checksum", () => {
    expect(normalizeIban("CZ3401000000000002970297")).toBeNull();
    const result = parseIban("CZ3401000000000002970297");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("IBAN checksum is invalid");
    }
  });

  test("rejects unknown country prefixes and non IBAN characters", () => {
    expect(normalizeIban("ZZ3301000000000002970297")).toBeNull();
    expect(normalizeIban("GA8900000000000000000000000")).toBeNull();
    expect(normalizeIban("CZ33010000000000029702-7")).toBeNull();
  });

  test("accepts registry countries added to the supported length table", () => {
    expect(normalizeIban("HN88CABF00000000000250005469")).toBe(
      "HN88CABF00000000000250005469",
    );
    expect(normalizeIban("YE15CBYE0001018861234567891234")).toBe(
      "YE15CBYE0001018861234567891234",
    );
  });

  test("accepts Brazil's current registry format", () => {
    expect(normalizeIban("BR6699999A03000010009795493C1")).toBe(
      "BR6699999A03000010009795493C1",
    );
  });
});
