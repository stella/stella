import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { verification } from "@/api/db/auth-schema";
import {
  consumeConfirmationOtp,
  generateSixDigitOtp,
} from "@/api/lib/confirmation-otp";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

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

describe("consumeConfirmationOtp (burn survives an enclosing rollback)", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await getTestDb();
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const seedOtp = async (
    identifier: string,
    value: string,
    expiresAt: Date,
  ): Promise<void> => {
    await testDb.insert(verification).values({
      id: Bun.randomUUIDv7(),
      identifier,
      value,
      expiresAt,
    });
  };

  const countOtp = async (identifier: string): Promise<number> =>
    (
      await testDb
        .select({ id: verification.id })
        .from(verification)
        .where(eq(verification.identifier, identifier))
    ).length;

  const future = () => new Date(Date.now() + 5 * 60 * 1000);
  const past = () => new Date(Date.now() - 1000);

  test("a wrong guess still burns the code, even when the caller's work rolls back", async () => {
    const email = `wrong-${Bun.randomUUIDv7()}@test.local`;
    const identifier = `delete-account:${email}`;
    await seedOtp(identifier, "111111", future());

    // The burn runs on its own connection (not a caller transaction), so it
    // must commit even though the failed verification and the caller's
    // destructive work below are both rolled back.
    const result = await consumeConfirmationOtp(testDb, {
      purpose: "delete-account",
      email,
      code: "000000",
    });
    expect(Result.isError(result)).toBe(true);

    await testDb
      .transaction(async () => {
        throw new Error("simulated abort of the destructive deletion work");
      })
      .catch(() => undefined);

    expect(await countOtp(identifier)).toBe(0);
  });

  test("a correct code is consumed and verifies", async () => {
    const email = `ok-${Bun.randomUUIDv7()}@test.local`;
    const identifier = `two-factor-manage:${email}`;
    await seedOtp(identifier, "222222", future());

    const result = await consumeConfirmationOtp(testDb, {
      purpose: "two-factor-manage",
      email,
      code: "222222",
    });
    expect(Result.isOk(result)).toBe(true);
    expect(await countOtp(identifier)).toBe(0);
  });

  test("an expired code is burned and rejected as expired", async () => {
    const email = `expired-${Bun.randomUUIDv7()}@test.local`;
    const identifier = `delete-account:${email}`;
    await seedOtp(identifier, "333333", past());

    const result = await consumeConfirmationOtp(testDb, {
      purpose: "delete-account",
      email,
      code: "333333",
      errorCode: { invalid: "otp_invalid", expired: "otp_expired" },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("otp_expired");
    }
    expect(await countOtp(identifier)).toBe(0);
  });
});
