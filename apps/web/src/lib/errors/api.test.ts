import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  AI_FAILURE_CODES,
  API_VALIDATION_ERROR_CODE,
} from "@stll/api-contract";

import messages from "@/i18n/langs/en.json";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

import {
  APIError,
  apiResponseResult,
  isDisplayableAPIError,
  toAPIError,
} from "./api";

describe("AI API failures", () => {
  test.each(Object.values(AI_FAILURE_CODES))(
    "localizes and displays %s",
    (code) => {
      const error = toAPIError({
        status: 502,
        value: { code, message: "Private provider detail" },
      });

      expect(isDisplayableAPIError(error)).toBe(true);
      expect(userErrorFromThrown(error, "Generic fallback")).toBe(
        error.message,
      );
      expect(error.message).not.toBe("Generic fallback");
      expect(error.message).not.toBe("Private provider detail");
    },
  );

  test("shows a retry message for an incomplete model output", () => {
    const error = toAPIError({
      status: 502,
      value: {
        code: AI_FAILURE_CODES.output_incomplete,
        message: "Failed to improve search query",
      },
    });

    expect(isDisplayableAPIError(error)).toBe(true);
    expect(userErrorFromThrown(error, "Something went wrong")).toBe(
      messages.chat.sendErrorStreamIncomplete,
    );
  });

  test.each([
    [
      AI_FAILURE_CODES.output_moderated,
      messages.errors.apiCodes.aiOutputModerated,
    ],
    [AI_FAILURE_CODES.unknown, messages.errors.apiCodes.aiUnknown],
    [
      AI_FAILURE_CODES.deadline_exceeded,
      messages.errors.apiCodes.aiDeadlineExceeded,
    ],
    [
      AI_FAILURE_CODES.provider_task_unsupported,
      messages.errors.apiCodes.aiProviderTaskUnsupported,
    ],
    [
      AI_FAILURE_CODES.model_unavailable,
      messages.chat.sendErrorModelUnavailable,
    ],
  ])("shows the specific message for %s", (code, message) => {
    const error = toAPIError({
      status: 502,
      value: { code, message: "Private provider detail" },
    });

    expect(error.message).toBe(message);
  });
});

describe("server errors outside AI", () => {
  test("a generic server error keeps the caller's fallback", () => {
    const error = toAPIError({
      status: 500,
      value: { code: "internal_server_error", message: "Server detail" },
    });

    expect(userErrorFromThrown(error, "Action failed")).toBe("Action failed");
  });
});

describe("transport failures", () => {
  test.each([
    ["network", messages.common.networkError],
    ["timeout", messages.transportErrors.timeout],
  ] as const)("localizes %s failures", (kind, expectedMessage) => {
    const error = toAPIError({ status: 0, value: null, kind });

    expect(error.message).toBe(expectedMessage);
  });

  test("keeps an aborted request distinct from a network failure", () => {
    const error = toAPIError({
      status: 0,
      value: null,
      kind: "aborted",
      cause: new DOMException("Cancelled", "AbortError"),
    });

    expect(error.transportKind).toBe("aborted");
    expect(error.message).not.toBe(messages.common.networkError);
  });
});

describe("validation API failures", () => {
  test.each([
    [302, messages.errors.api.unknown],
    [422, messages.errors.apiCodes.validationTooLong],
    [503, messages.errors.api.serviceUnavailable],
  ])("maps validation code at status %i", (status, expectedMessage) => {
    const error = toAPIError({
      status,
      value: {
        code: API_VALIDATION_ERROR_CODE,
        message: "Private validation detail",
        issues: [{ field: "name", constraint: "maxLength", limit: 256 }],
      },
    });

    expect(error.message).toBe(
      expectedMessage.replace("{limit, number}", "256"),
    );
  });
});

test("API response results retain nullable data and localized refusal classifications", () => {
  expect(apiResponseResult({ data: null, error: null })).toEqual(
    Result.ok(null),
  );
  const result = apiResponseResult({
    data: null,
    error: {
      status: 403,
      value: { code: "forbidden", message: "Server detail" },
    },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(APIError.is(result.error)).toBe(true);
    expect(result.error).toMatchObject({
      status: 403,
      code: "forbidden",
      message: messages.errors.apiCodes.forbidden,
    });
  }
});

test("API response results preserve malformed refusal errors without throwing", () => {
  const result = apiResponseResult({
    data: null,
    error: {
      status: 502,
      value: { message: "Refused", providerDiagnostic: { invalid: true } },
    },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(ClientOperationError.is(result.error)).toBe(true);
    expect(result.error).toMatchObject({
      action: "parse-provider-diagnostic",
      message: "Invalid provider diagnostic response",
    });
  }
});

test("search work limits provide the translated refinement action", () => {
  const error = toAPIError({
    status: 422,
    value: {
      code: "global_search_rank_work_limit",
      message: "Search work limit",
    },
  });
  expect(error.message).toBe(messages.caseLaw.pagination.refineForMore);
  expect(isDisplayableAPIError(error)).toBe(true);
});
