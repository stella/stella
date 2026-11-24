import { describe, expect, test } from "bun:test";

import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";

import { APIError } from "@/lib/errors/api";

import { isSsoSignInRequiredError } from "./sso-sign-in-required";

describe("isSsoSignInRequiredError", () => {
  test("matches 403 APIError with sso_sign_in_required code", () => {
    expect(
      isSsoSignInRequiredError(
        new APIError({
          status: 403,
          code: SSO_SIGN_IN_REQUIRED_CODE,
          message: "SSO required",
        }),
      ),
    ).toBe(true);
  });

  test("ignores other 403 codes and non-403 statuses", () => {
    expect(
      isSsoSignInRequiredError(
        new APIError({
          status: 403,
          code: "forbidden",
          message: "Forbidden",
        }),
      ),
    ).toBe(false);
    expect(
      isSsoSignInRequiredError(
        new APIError({
          status: 401,
          code: SSO_SIGN_IN_REQUIRED_CODE,
          message: "Unauthorized",
        }),
      ),
    ).toBe(false);
  });
});
