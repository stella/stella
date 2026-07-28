import { describe, expect, test } from "bun:test";

import {
  normalizeKrsNumber,
  validateKrsNumber,
  validateNip,
  validateRegon,
} from "./validation.js";

describe("normalizeKrsNumber", () => {
  test("strips whitespace", () => {
    expect(normalizeKrsNumber(" 0000006865 ")).toBe("0000006865");
    expect(normalizeKrsNumber("0000006865\n")).toBe("0000006865");
    expect(normalizeKrsNumber("0000 006 865")).toBe("0000006865");
  });
});

describe("Polish alternate registry identifiers", () => {
  test("validates NIP checksums", () => {
    expect(validateNip("7342867148")).toBe(true);
    expect(validateNip("7342867149")).toBe(false);
  });

  test("accepts national REGON values and their KRS zero-padded form", () => {
    expect(validateRegon("492707333")).toBe(true);
    expect(validateRegon("49270733300000")).toBe(true);
    expect(validateRegon("49270733400000")).toBe(false);
  });
});

describe("validateKrsNumber", () => {
  test("accepts well-formed 10-digit KRS numbers", () => {
    // CD Projekt SA
    expect(validateKrsNumber("0000006865")).toBe(true);
    // Orlen SA
    expect(validateKrsNumber("0000028860")).toBe(true);
    // Caritas Polska (association register)
    expect(validateKrsNumber("0000198645")).toBe(true);
  });

  test("rejects non-10-digit lengths", () => {
    // Crucial: we do NOT pad shorter inputs. "6865" is ambiguous and
    // must fall through to a validation error, not be silently
    // padded to "0000006865".
    expect(validateKrsNumber("6865")).toBe(false);
    expect(validateKrsNumber("000006865")).toBe(false);
    expect(validateKrsNumber("00000068650")).toBe(false);
    expect(validateKrsNumber("")).toBe(false);
  });

  test("rejects non-digit characters", () => {
    expect(validateKrsNumber("000000abcd")).toBe(false);
    expect(validateKrsNumber("0000-006865")).toBe(false);
    expect(validateKrsNumber("000000.865")).toBe(false);
  });

  test("normalises whitespace before checking length", () => {
    expect(validateKrsNumber(" 0000006865 ")).toBe(true);
    expect(validateKrsNumber("0000 006 865")).toBe(true);
  });
});
