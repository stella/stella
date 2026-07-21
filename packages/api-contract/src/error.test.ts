import { describe, expect, test } from "bun:test";

import { API_VALIDATION_ERROR_CODE, normalizeApiError } from "./error";

describe("normalizeApiError", () => {
  test("keeps an empty response status-only", () => {
    expect(normalizeApiError({ status: 502, value: null })).toEqual({
      status: 502,
    });
  });

  test("preserves a string response as the raw message", () => {
    expect(normalizeApiError({ status: 400, value: "Bad request" })).toEqual({
      rawMessage: "Bad request",
      status: 400,
    });
  });

  test("classifies and serializes validation responses", () => {
    expect(
      normalizeApiError({
        status: 422,
        value: {
          on: "body",
          summary: "Invalid request",
          type: "validation",
        },
      }),
    ).toEqual({
      code: API_VALIDATION_ERROR_CODE,
      rawMessage:
        '{"on":"body","summary":"Invalid request","type":"validation"}',
      status: 422,
    });
  });

  test("separates object codes, messages, and structured details", () => {
    expect(
      normalizeApiError({
        status: 402,
        value: {
          code: "usage_limit_exceeded",
          message: "Usage limit exceeded",
          reason: "no_entitlement",
        },
      }),
    ).toEqual({
      code: "usage_limit_exceeded",
      details: { reason: "no_entitlement" },
      rawMessage: "Usage limit exceeded",
      status: 402,
    });
  });
});
