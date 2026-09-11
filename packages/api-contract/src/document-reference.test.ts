import { describe, expect, test } from "bun:test";

import {
  isVerificationCode,
  VERIFICATION_CODE_ALPHABET,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_PATTERN,
} from "./document-reference";

const FROZEN = [
  "Changing the verification-code alphabet or length retires every reference",
  "already printed into a document outside the product: those files cannot be",
  "reissued, so their codes would stop parsing and resolving. Accept a further",
  "format alongside this one instead of altering this one.",
].join(" ");

describe("verification code contract", () => {
  // The literals are spelled out rather than derived, so editing the constant
  // fails here instead of silently redefining the printed format.
  test("alphabet and length are frozen", () => {
    expect(VERIFICATION_CODE_ALPHABET, FROZEN).toBe(
      "abcdefghjkmnpqrstuvwxyz23456789",
    );
    expect(VERIFICATION_CODE_LENGTH, FROZEN).toBe(10);
    expect(VERIFICATION_CODE_PATTERN, FROZEN).toBe(
      "^[abcdefghjkmnpqrstuvwxyz23456789]{10}$",
    );
  });
});

describe("isVerificationCode", () => {
  test("accepts a ten-character code from the printed alphabet", () => {
    expect(isVerificationCode("abcdmnp239")).toBe(true);
  });

  test.each([
    ["abcdmnp230"], // 0 and O read alike
    ["abcdmnp23o"],
    ["abcdmnp23O"],
    ["abcdmnp231"], // 1, l and I read alike
    ["abcdmnp23l"],
    ["abcdmnp23I"],
    ["ABCDMNP239"], // codes are printed lowercase
    ["abcdmnp23"], // nine characters
    ["abcdmnp2399"], // eleven characters
    [""],
    ["abcdmnp23-"],
    ["abcd mnp23"],
  ])("rejects %p", (code) => {
    expect(isVerificationCode(code)).toBe(false);
  });
});
