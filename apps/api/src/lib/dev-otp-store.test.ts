import {
  afterEach,
  describe,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";

import { readDevOtp, stashDevOtp } from "@/api/lib/dev-otp-store";

const OTP_TTL_MS = 5 * 60_000;
const TEST_START_MS = Date.UTC(2026, 0, 1);

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

describe("dev OTP store", () => {
  test("repeated reads return the latest unexpired OTP", () => {
    jest.useFakeTimers();
    const email = "repeated-loader@example.test";

    stashDevOtp(email, "123456");

    expect(readDevOtp(email)).toBe("123456");
    expect(readDevOtp(email)).toBe("123456");
  });

  test("expires an OTP at the exact TTL boundary", () => {
    jest.useFakeTimers();
    setSystemTime(TEST_START_MS);
    const email = "ttl-boundary@example.test";

    stashDevOtp(email, "234567");
    setSystemTime(TEST_START_MS + OTP_TTL_MS);

    expect(readDevOtp(email)).toBeNull();
  });

  test("a stale eviction timer cannot delete a replacement OTP", () => {
    jest.useFakeTimers();
    setSystemTime(TEST_START_MS);
    const email = "replacement@example.test";

    stashDevOtp(email, "345678");
    jest.advanceTimersByTime(OTP_TTL_MS / 2);
    stashDevOtp(email, "456789");
    jest.advanceTimersByTime(OTP_TTL_MS / 2);

    expect(readDevOtp(email)).toBe("456789");

    jest.advanceTimersByTime(OTP_TTL_MS / 2);
    expect(readDevOtp(email)).toBeNull();
  });
});
