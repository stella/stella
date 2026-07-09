import { describe, expect, test } from "bun:test";

import {
  APIError,
  AuthClientError,
  internalToolErrorMessage,
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

  test.each([
    [
      "deepl_key_rejected",
      "The stored DeepL key was rejected. Replace it in organization settings.",
    ],
    [
      "deepl_quota_exceeded",
      "The DeepL character quota for this organization has been used up.",
    ],
    ["provider_key_rejected", "The provider rejected the API key."],
    [
      "provider_rate_limited",
      "The provider rate limit was reached. Try again shortly.",
    ],
  ])("localizes the known provider code %s", (code, expected) => {
    const error = toAPIError({
      status: 400,
      value: { code, message: "Raw provider error" },
    });

    expect(error.message).toBe(expected);
    expect(error.rawMessage).toBe("Raw provider error");
  });

  test.each([
    [
      "legal_source_entity_limit_reached",
      "This matter has reached the entity limit, so the document could not be created.",
    ],
    [
      "legal_source_file_property_missing",
      "This matter is missing a file property, so the document could not be created.",
    ],
  ])("localizes the legal-source creation code %s", (code, expected) => {
    const error = toAPIError({
      status: 422,
      value: { code, message: "Raw legal-source creation error" },
    });

    expect(error.message).toBe(expected);
    expect(error.rawMessage).toBe("Raw legal-source creation error");
  });

  test.each([
    ["account_deletion_otp_invalid", "Invalid verification code."],
    [
      "account_deletion_otp_expired",
      "The verification code has expired. Request a new code.",
    ],
  ])("localizes the account deletion code %s", (code, expected) => {
    const error = toAPIError({
      status: 400,
      value: { code, message: "Raw verification error" },
    });

    expect(error.message).toBe(expected);
    expect(error.rawMessage).toBe("Raw verification error");
  });

  test.each([
    [
      "account_deletion_task_reassignment_invalid",
      "Review every active task reassignment. Each target must be another member of the task's matter who is not already assigned.",
    ],
    [
      "account_deletion_task_reassignment_limit_exceeded",
      "Too many active task assignments must be reassigned. Complete or reassign some tasks before deleting your account.",
    ],
  ])("localizes the task reassignment code %s", (code, expected) => {
    const error = toAPIError({
      status: 400,
      value: { code, message: "Raw task reassignment error" },
    });

    expect(error.message).toBe(expected);
    expect(error.rawMessage).toBe("Raw task reassignment error");
  });

  test.each([
    [
      "account_deletion_sole_owner",
      "Transfer ownership or delete organizations you solely own before deleting your account.",
    ],
    [
      "ai_config_provider_invalid",
      "The AI provider configuration is invalid. Check the provider settings.",
    ],
    [
      "ai_config_model_invalid",
      "The AI model configuration is invalid. Check the selected models.",
    ],
    [
      "ai_config_provider_validation_failed",
      "The AI provider rejected the configuration. Check the API key and model.",
    ],
  ])("localizes the actionable configuration code %s", (code, expected) => {
    const error = toAPIError({
      status: 400,
      value: { code, message: "Raw configuration error" },
    });

    expect(error.message).toBe(expected);
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

  test("does not label uncoded payment-required responses as usage limits", () => {
    const error = toAPIError({
      status: 402,
      value: {
        message: "The configured AI provider rejected the request.",
      },
    });

    expect(error.message).toBe("The request failed. Please try again.");
  });

  test("localizes payment-required responses with a usage-limit reason", () => {
    const value = {
      message: "Usage limit exceeded",
      reason: "usage_limit_exceeded",
    };
    const error = toAPIError({ status: 402, value });

    expect(error.message).toBe("Usage limit reached.");
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

  test.each(["entitlement_inactive", "no_entitlement", "usage_limit_exceeded"])(
    "shows localized structured usage rejection %s",
    (reason) => {
      const value = {
        message: "Raw usage rejection",
        reason,
      };

      expect(
        userErrorMessage(
          {
            status: 402,
            value,
          },
          "Something went wrong",
        ),
      ).toBe("Usage limit reached.");
    },
  );

  test("uses fallback for unmapped coded 4xx messages", () => {
    expect(
      userErrorMessage(
        {
          status: 409,
          value: {
            code: "desktop_edit_session_taken_over",
            message: "Desktop edit session was taken over.",
          },
        },
        "Something went wrong",
      ),
    ).toBe("Something went wrong");
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

  test("uses fallback for thrown unmapped API error codes", () => {
    expect(
      userErrorFromThrown(
        new APIError({
          code: "desktop_edit_session_taken_over",
          message: "The request conflicts with the current state.",
          status: 409,
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

describe("internalToolErrorMessage", () => {
  test("preserves allowlisted structural repair diagnostics", () => {
    const error = toAPIError({
      status: 422,
      value: {
        code: "legal_source_structural_repair_required",
        message: "Structural repair required: section heading is missing",
      },
    });

    expect(internalToolErrorMessage(error)).toBe(
      "Structural repair required: section heading is missing",
    );
  });

  test("does not expose raw messages for other errors", () => {
    const error = toAPIError({
      status: 422,
      value: {
        code: "unexpected_internal_detail",
        message: "Sensitive raw detail",
      },
    });

    expect(internalToolErrorMessage(error)).toBe(
      "Please check the request and try again.",
    );
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
    if (APIError.is(error)) {
      expect(error.message).toBe("Please sign in again.");
      expect(error.rawMessage).toBe("Unexpected");
    }
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
