import { describe, expect, test } from "bun:test";

import {
  APIError,
  AuthClientError,
  isMemberError,
  isUnauthorizedError,
  toAPIError,
  toAuthClientError,
  userErrorMessage,
} from "./index";

describe("toAPIError", () => {
  test("wraps string payloads directly", () => {
    const error = toAPIError({
      status: 400,
      value: "Bad request",
    });

    expect(APIError.is(error)).toBe(true);
    expect(error.message).toBe("Bad request");
  });

  test("serializes validation payloads", () => {
    const error = toAPIError({
      status: 422,
      value: {
        type: "validation",
        on: "body",
        summary: "Invalid request",
      },
    });

    expect(error.message).toContain('"type":"validation"');
    expect(error.message).toContain('"on":"body"');
  });

  test("uses object message for non-validation payloads", () => {
    const error = toAPIError({
      status: 404,
      value: {
        message: "Not found",
      },
    });

    expect(error.message).toBe("Not found");
  });
});

describe("userErrorMessage", () => {
  test("hides 5xx details behind the fallback", () => {
    expect(
      userErrorMessage(
        {
          status: 500,
          value: "Internal details",
        },
        "Something went wrong",
      ),
    ).toBe("Something went wrong");
  });

  test("shows 4xx messages directly", () => {
    expect(
      userErrorMessage(
        {
          status: 400,
          value: "Missing field",
        },
        "Something went wrong",
      ),
    ).toBe("Missing field");
  });
});

describe("toAuthClientError", () => {
  test("returns AuthClientError when code is absent", () => {
    const error = toAuthClientError({
      status: 400,
      statusText: "Bad Request",
    });

    expect(AuthClientError.is(error)).toBe(true);
    expect(error.message).toBe("Unknown better-auth error");
  });

  test("falls back to APIError for unknown codes", () => {
    const error = toAuthClientError({
      code: "SOMETHING_ELSE",
      message: "Unexpected",
      status: 401,
      statusText: "Unauthorized",
    });

    expect(APIError.is(error)).toBe(true);
    expect(error.message).toBe("SOMETHING_ELSE - Unexpected");
  });
});

describe("error predicates", () => {
  test("isMemberError matches the membership auth code only", () => {
    const memberError = new AuthClientError({
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      message: "No membership",
      status: 403,
      statusText: "Forbidden",
    });
    const otherError = new AuthClientError({
      message: "Other",
      status: 403,
      statusText: "Forbidden",
    });

    expect(isMemberError(memberError)).toBe(true);
    expect(isMemberError(otherError)).toBe(false);
  });

  test("isUnauthorizedError matches API and auth 401 errors", () => {
    const apiError = new APIError({
      message: "Unauthorized",
      status: 401,
    });
    const authError = new AuthClientError({
      message: "Unauthorized",
      status: 401,
      statusText: "Unauthorized",
    });
    const forbidden = new APIError({
      message: "Forbidden",
      status: 403,
    });

    expect(isUnauthorizedError(apiError)).toBe(true);
    expect(isUnauthorizedError(authError)).toBe(true);
    expect(isUnauthorizedError(forbidden)).toBe(false);
  });
});
