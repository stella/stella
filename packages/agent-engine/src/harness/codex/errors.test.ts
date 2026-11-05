import { describe, expect, test } from "bun:test";

import { classifyTurnFailure } from "./errors";

const usageLimit = {
  message: "You've hit your usage limit.",
  codexErrorInfo: "usageLimitExceeded",
  additionalDetails: null,
} as const;

const exhaustedUntil = (resetsAt: number) => ({
  limitId: "codex",
  primary: { usedPercent: 100, resetsAt },
  secondary: null,
});

describe("Codex turn failures", () => {
  test("a usage limit carries the time its exhausted window resets", () => {
    expect(
      classifyTurnFailure({
        error: usageLimit,
        rateLimits: exhaustedUntil(1_793_196_000),
      }),
    ).toEqual({
      type: "usage_limit",
      message: usageLimit.message,
      resetsAt: "2026-10-28T14:00:00.000Z",
    });
  });

  test("a reset time past the date range is reported as unknown, not thrown", () => {
    expect(
      classifyTurnFailure({
        error: usageLimit,
        rateLimits: exhaustedUntil(1e300),
      }),
    ).toEqual({
      type: "usage_limit",
      message: usageLimit.message,
      resetsAt: null,
    });
  });

  test("a Sharing allowance reported as a stream disconnect is a usage limit with no known reset", () => {
    const message =
      "stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
    expect(
      classifyTurnFailure({
        error: {
          message,
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        },
        rateLimits: exhaustedUntil(1_793_196_000),
      }),
    ).toEqual({ type: "usage_limit", message, resetsAt: null });
  });

  test("any other stream disconnect stays a provider error", () => {
    const message = "stream disconnected before completion: connection reset";
    expect(
      classifyTurnFailure({
        error: {
          message,
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        },
        rateLimits: null,
      }),
    ).toEqual({
      type: "provider_error",
      message,
      code: "responseStreamDisconnected",
    });
  });
});
