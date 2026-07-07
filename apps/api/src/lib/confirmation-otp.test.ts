import { describe, expect, test } from "bun:test";

import { generateSixDigitOtp } from "@/api/lib/confirmation-otp";

describe("generateSixDigitOtp", () => {
  test("always produces a 6-digit numeric string", () => {
    for (let i = 0; i < 200; i++) {
      const otp = generateSixDigitOtp();
      expect(otp).toMatch(/^\d{6}$/u);
      const value = Number(otp);
      expect(value).toBeGreaterThanOrEqual(100_000);
      expect(value).toBeLessThanOrEqual(999_999);
    }
  });

  test("does not repeat the same code across a small batch (collision-resistant)", () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateSixDigitOtp()),
    );

    // Not a strict guarantee, but 50 draws from a 900,000-value space
    // colliding down to a handful of unique values would indicate a broken
    // generator (e.g. always returning the same value).
    expect(codes.size).toBeGreaterThan(40);
  });
});
