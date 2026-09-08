import { describe, expect, test } from "bun:test";

import { isVerificationCode } from "@/lib/document-reference";

describe("verification code shape", () => {
  test("accepts a ten-character code from the printed alphabet", () => {
    expect(isVerificationCode("abcdmnp239")).toBe(true);
  });

  test("rejects lengths other than ten", () => {
    expect(isVerificationCode("abcdmnp23")).toBe(false);
    expect(isVerificationCode("abcdmnp2399")).toBe(false);
    expect(isVerificationCode("")).toBe(false);
  });

  test("rejects characters the alphabet leaves out", () => {
    for (const code of [
      "abcdmnp23o", // o and 0 read alike
      "abcdmnp230",
      "abcdmnp23l", // l, 1 and i read alike
      "abcdmnp231",
      "abcdmnp23i",
      "ABCDMNP239", // codes are printed lowercase
      "abcdmnp23-",
      "abcd mnp23",
    ]) {
      expect(isVerificationCode(code)).toBe(false);
    }
  });
});
