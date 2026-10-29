import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rootDb } from "@/api/db/root";
import { createConfirmedAccountUnlinker } from "@/api/lib/auth/unlink-account";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";

const unlinkAccountWithConfirmation = createConfirmedAccountUnlinker({
  database: rootDb,
  verifyConfirmation: verifyConfirmationOtp,
});

const signedIn = {
  user: { id: "sign-in-method-user", email: "jana@sign-in.test" },
};

describe("sign-in method removal input boundary", () => {
  test("requires a signed-in account before accepting confirmation", async () => {
    const result = await unlinkAccountWithConfirmation({
      session: null,
      body: { accountId: "linked-account", otp: "123456" },
    });
    if (Result.isOk(result)) {
      panic("A signed-out request should be refused");
    }
    expect(result.error).toBeInstanceOf(APIError);
    expect(result.error.status).toBe("UNAUTHORIZED");
    expect(result.error.body).toMatchObject({ message: "Unauthorized" });
  });

  test.each([
    { name: "absent body", body: undefined },
    { name: "null body", body: null },
    { name: "missing account", body: { otp: "123456" } },
    { name: "empty account", body: { accountId: "", otp: "123456" } },
    { name: "numeric account", body: { accountId: 42, otp: "123456" } },
    { name: "missing confirmation", body: { accountId: "linked-account" } },
    {
      name: "empty confirmation",
      body: { accountId: "linked-account", otp: "" },
    },
    {
      name: "short confirmation",
      body: { accountId: "linked-account", otp: "12345" },
    },
    {
      name: "long confirmation",
      body: { accountId: "linked-account", otp: "1234567" },
    },
    {
      name: "nonnumeric confirmation",
      body: { accountId: "linked-account", otp: "abcdef" },
    },
    {
      name: "numeric confirmation",
      body: { accountId: "linked-account", otp: 123_456 },
    },
    {
      name: "padded confirmation",
      body: { accountId: "linked-account", otp: " 123456 " },
    },
  ])("refuses $name before verifying confirmation", async ({ body }) => {
    const result = await unlinkAccountWithConfirmation({
      session: signedIn,
      body,
    });
    if (Result.isOk(result)) {
      panic("An incomplete confirmation request should be refused");
    }
    expect(result.error).toBeInstanceOf(APIError);
    expect(result.error.status).toBe("BAD_REQUEST");
    expect(result.error.body).toMatchObject({
      message: "Account and verification code required",
    });
  });
});
