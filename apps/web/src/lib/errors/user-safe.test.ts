import { Result } from "better-result";
import { expect, test } from "bun:test";

import en from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

const FALLBACK = "Fallback";

const refusal = () =>
  toAuthClientError({
    code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    message: "User is already a member of this organization",
    status: 400,
    statusText: "Bad Request",
  });

test("a typed error shows its own message", () => {
  expect(userErrorFromThrown(refusal(), FALLBACK)).toBe(
    en.errors.apiCodes.alreadyOrganizationMember,
  );
});

test("a typed error caught by Result.tryPromise keeps its message", async () => {
  const result = await Result.tryPromise(async () => {
    await Promise.resolve();
    throw refusal();
  });
  if (!Result.isError(result)) {
    throw new TypeError("Expected the call to fail");
  }
  expect(userErrorFromThrown(result.error, FALLBACK)).toBe(
    en.errors.apiCodes.alreadyOrganizationMember,
  );
});

test("an untyped failure caught the same way keeps the caller's fallback", async () => {
  const result = await Result.tryPromise(async () => {
    await Promise.resolve();
    throw new TypeError("internal detail");
  });
  if (!Result.isError(result)) {
    throw new TypeError("Expected the call to fail");
  }
  expect(userErrorFromThrown(result.error, FALLBACK)).toBe(FALLBACK);
});

test("a transport failure caught the same way keeps the caller's fallback", async () => {
  const result = await Result.tryPromise(async () => {
    await Promise.resolve();
    throw new APIError({
      message: "Network error",
      status: 0,
      transportKind: "network",
    });
  });
  if (!Result.isError(result)) {
    throw new TypeError("Expected the call to fail");
  }
  expect(userErrorFromThrown(result.error, FALLBACK)).toBe(FALLBACK);
});
