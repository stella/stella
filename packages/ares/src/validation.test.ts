import { describe, expect, test } from "bun:test";

import { normalizeIco, validateIco } from "./validation.js";

describe("validateIco", () => {
  test("valid IČO passes checksum", () => {
    expect(validateIco("27074358")).toBe(true);
    expect(validateIco("00027383")).toBe(true); // ČEZ
    expect(validateIco("45274649")).toBe(true); // Škoda Auto
    expect(validateIco("25596641")).toBe(true); // Mall.cz
  });

  test("accepts IČO with spaces", () => {
    expect(validateIco("270 74 358")).toBe(true);
  });

  test("rejects short input (missing leading zeros)", () => {
    expect(validateIco("27383")).toBe(false);
  });

  test("rejects invalid checksum", () => {
    expect(validateIco("27074359")).toBe(false);
    expect(validateIco("12345678")).toBe(false);
  });

  test("rejects too-long input", () => {
    expect(validateIco("123456789")).toBe(false);
  });

  test("rejects non-numeric input", () => {
    expect(validateIco("ABCDEFGH")).toBe(false);
    expect(validateIco("")).toBe(false);
  });
});

describe("normalizeIco", () => {
  test("strips spaces", () => {
    expect(normalizeIco("270 74 358")).toBe("27074358");
  });

  test("strips dashes", () => {
    expect(normalizeIco("270-74-358")).toBe("27074358");
  });

  test("leaves 8-digit IČO unchanged", () => {
    expect(normalizeIco("27074358")).toBe("27074358");
  });
});
