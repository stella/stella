import { describe, expect, test } from "bun:test";

import {
  APIError,
  AuthClientError,
  isMemberError,
  isUnauthorizedError,
  toAPIError,
  toAuthClientError,
  userErrorFromThrown,
  userErrorMessage,
} from "./index";

describe("toAPIError", () => {
  test("localizes string payloads by status and preserves the raw message", () => {
    const error = toAPIError({
      status: 400,
      value: "Bad request",
    });

    expect(APIError.is(error)).toBe(true);
    expect(error.message).toBe("The request could not be completed.");
    expect(error.rawMessage).toBe("Bad request");
  });

  test("localizes validation payloads and preserves serialized details", () => {
    const error = toAPIError({
      status: 422,
      value: {
        type: "validation",
        on: "body",
        summary: "Invalid request",
      },
    });

    expect(error.code).toBe("validation");
    expect(error.message).toBe("Please check the request and try again.");
    expect(error.rawMessage).toContain('"type":"validation"');
    expect(error.rawMessage).toContain('"on":"body"');
  });

  test("localizes uncoded object payloads by status", () => {
    const error = toAPIError({
      status: 404,
      value: {
        message: "Not found",
      },
    });

    expect(error.message).toBe("We could not find what you requested.");
    expect(error.rawMessage).toBe("Not found");
  });

  test("localizes known object codes", () => {
    const error = toAPIError({
      status: 403,
      value: {
        code: "forbidden",
        message: "Forbidden",
      },
    });

    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("You do not have permission to do this.");
    expect(error.rawMessage).toBe("Forbidden");
  });

  test("localizes malformed empty payloads by status", () => {
    const error = toAPIError({
      status: 502,
      value: null,
    });

    expect(error.message).toBe(
      "The service is temporarily unavailable. Please try again.",
    );
    expect(error.rawMessage).toBeUndefined();
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

  test("uses fallback for uncoded 4xx messages", () => {
    expect(
      userErrorMessage(
        {
          status: 400,
          value: "Missing field",
        },
        "Something went wrong",
      ),
    ).toBe("Something went wrong");
  });

  test("shows localized coded 4xx messages", () => {
    expect(
      userErrorMessage(
        {
          status: 403,
          value: {
            code: "forbidden",
            message: "Forbidden",
          },
        },
        "Something went wrong",
      ),
    ).toBe("You do not have permission to do this.");
  });

  test("uses fallback for thrown uncoded API errors", () => {
    expect(
      userErrorFromThrown(
        new APIError({
          message: "Raw message",
          status: 400,
        }),
        "Something went wrong",
      ),
    ).toBe("Something went wrong");
  });

  test("shows localized coded thrown API errors", () => {
    expect(
      userErrorFromThrown(
        new APIError({
          code: "usage_limit_exceeded",
          message: "Usage limit reached.",
          status: 402,
        }),
        "Something went wrong",
      ),
    ).toBe("Usage limit reached.");
  });

  test("shows localized thrown auth client errors", () => {
    expect(
      userErrorFromThrown(
        new AuthClientError({
          code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
          message: "You are not a member of this organization.",
          status: 403,
          statusText: "Forbidden",
        }),
        "Something went wrong",
      ),
    ).toBe("You are not a member of this organization.");
  });
});

describe("toAuthClientError", () => {
  test("returns AuthClientError when code is absent", () => {
    const error = toAuthClientError({
      status: 400,
      statusText: "Bad Request",
    });

    expect(AuthClientError.is(error)).toBe(true);
    expect(error.message).toBe("The request could not be completed.");
  });

  test("falls back to APIError for unknown codes", () => {
    const error = toAuthClientError({
      code: "SOMETHING_ELSE",
      message: "Unexpected",
      status: 401,
      statusText: "Unauthorized",
    });

    expect(APIError.is(error)).toBe(true);
    expect(error.message).toBe("Please sign in again.");
    expect(error.rawMessage).toBe("Unexpected");
  });

  test("localizes known auth client codes", () => {
    const error = toAuthClientError({
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      message: "No membership",
      status: 403,
      statusText: "Forbidden",
    });

    expect(AuthClientError.is(error)).toBe(true);
    expect(error.message).toBe("You are not a member of this organization.");
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
