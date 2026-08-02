import { describe, expect, test } from "bun:test";

import { readDevOtp, stashDevOtp } from "@/api/lib/dev-otp-store";

describe("dev OTP store", () => {
  test("repeated reads return the latest unexpired OTP", () => {
    const email = "repeated-loader@example.test";

    stashDevOtp(email, "123456");

    expect(readDevOtp(email)).toBe("123456");
    expect(readDevOtp(email)).toBe("123456");
  });
});
