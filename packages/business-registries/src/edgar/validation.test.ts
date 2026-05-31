import { describe, expect, test } from "bun:test";

import { normalizeCik, padCik, validateCik } from "./validation.js";

describe("normalizeCik", () => {
  test("strips whitespace and CIK prefix", () => {
    expect(normalizeCik("CIK0000320193")).toBe("320193");
    expect(normalizeCik("cik#320193")).toBe("320193");
    expect(normalizeCik(" 320193 ")).toBe("320193");
  });

  test("strips leading zeros", () => {
    expect(normalizeCik("0000320193")).toBe("320193");
    expect(normalizeCik("0000000001")).toBe("1");
  });

  test("treats all-zeros as the placeholder '0'", () => {
    expect(normalizeCik("0000000000")).toBe("0");
    expect(normalizeCik("0")).toBe("0");
  });
});

describe("padCik", () => {
  test("pads to 10 digits", () => {
    expect(padCik("320193")).toBe("0000320193");
    expect(padCik("0000320193")).toBe("0000320193");
    expect(padCik("1")).toBe("0000000001");
  });

  test("normalises then pads", () => {
    expect(padCik("CIK320193")).toBe("0000320193");
  });
});

describe("validateCik", () => {
  test("accepts 1–10 digit input", () => {
    expect(validateCik("320193")).toBe(true);
    expect(validateCik("0000320193")).toBe(true);
    expect(validateCik("1")).toBe(true);
    expect(validateCik("9999999999")).toBe(true);
  });

  test("rejects more than 10 digits", () => {
    expect(validateCik("12345678901")).toBe(false);
  });

  test("rejects non-digit input", () => {
    expect(validateCik("abc")).toBe(false);
    expect(validateCik("32019x")).toBe(false);
    expect(validateCik("")).toBe(false);
  });

  test("rejects the reserved zero CIK", () => {
    expect(validateCik("0")).toBe(false);
    expect(validateCik("0000000000")).toBe(false);
  });

  test("accepts after stripping the 'CIK' prefix", () => {
    expect(validateCik("CIK0000320193")).toBe(true);
  });
});
