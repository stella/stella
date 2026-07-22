import { describe, expect, test } from "bun:test";

import { parseEmailOtp, parseSignInEmail } from "./auth-input";

describe("mobile auth input", () => {
  test("normalizes a valid email", () => {
    expect(parseSignInEmail("  person@example.com ")).toBe(
      "person@example.com",
    );
  });

  test("rejects malformed email input", () => {
    expect(() => parseSignInEmail("not-an-email")).toThrow();
  });

  test("accepts exactly six OTP digits", () => {
    expect(parseEmailOtp(" 123456 ")).toBe("123456");
  });

  test("rejects partial and non-numeric OTP input", () => {
    expect(() => parseEmailOtp("12345")).toThrow();
    expect(() => parseEmailOtp("12345a")).toThrow();
  });
});
