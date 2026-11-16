import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import { classifyTurnFailure, usageLimitResetsAt } from "./errors";

/** 2026-10-01T00:00:00Z, before every reset below but the stale one. */
const NOW = Temporal.Instant.from("2026-10-01T00:00:00Z");

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
        now: NOW,
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
        now: NOW,
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
        now: NOW,
      }),
    ).toEqual({ type: "usage_limit", message, resetsAt: null });
  });

  test("a model at capacity is its own failure, apart from a usage limit", () => {
    const message =
      "Selected model is at capacity. Please try a different model.";
    expect(
      classifyTurnFailure({
        error: { message, codexErrorInfo: "serverOverloaded" },
        // An exhausted allowance does not make capacity a usage limit.
        rateLimits: exhaustedUntil(1_793_196_000),
        now: NOW,
      }),
    ).toEqual({ type: "model_at_capacity", message });
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
        now: NOW,
      }),
    ).toEqual({
      type: "provider_error",
      message,
      code: "responseStreamDisconnected",
    });
  });

  test("a window whose reset has passed limits nothing, so the reset is unknown", () => {
    expect(
      classifyTurnFailure({
        error: usageLimit,
        rateLimits: exhaustedUntil(1_793_196_000),
        now: Temporal.Instant.from("2026-11-01T00:00:00Z"),
      }),
    ).toEqual({
      type: "usage_limit",
      message: usageLimit.message,
      resetsAt: null,
    });
  });

  test("the latest reset of the exhausted windows wins; a window in use does not count", () => {
    expect(
      usageLimitResetsAt(
        {
          limitId: "codex",
          primary: { usedPercent: 100, resetsAt: 1_793_196_000 },
          secondary: { usedPercent: 100, resetsAt: 1_793_700_000 },
        },
        NOW,
      ),
    ).toBe(new Date(1_793_700_000 * 1000).toISOString());
    expect(
      usageLimitResetsAt(
        {
          limitId: "codex",
          primary: { usedPercent: 99, resetsAt: 1_793_196_000 },
          secondary: null,
        },
        NOW,
      ),
    ).toBeNull();
  });
});
