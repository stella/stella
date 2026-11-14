import { describe, expect, test } from "bun:test";

import { extractFromError } from "@/components/usage/use-usage-limit";
import { APIError } from "@/lib/errors/api";

describe("extractFromError", () => {
  test("recognises an APIError with status 402", () => {
    const error = new APIError({
      status: 402,
      message: "Usage limit exceeded: need 50, have 10",
      details: { reason: "usage_limit_exceeded", required: 50, available: 10 },
    });
    const out = extractFromError(error);
    expect(out).not.toBeNull();
    expect(out?.reason).toBe("usage_limit_exceeded");
    expect(out?.details).toEqual({
      reason: "usage_limit_exceeded",
      required: 50,
      available: 10,
    });
  });

  test("returns null for an APIError with status != 402", () => {
    const error = new APIError({ status: 500, message: "server exploded" });
    expect(extractFromError(error)).toBeNull();
  });

  test("returns null for an APIError 402 without our reason marker", () => {
    const error = new APIError({
      status: 402,
      message: "provider quota exceeded",
      details: { error: "upstream provider quota" },
    });
    expect(extractFromError(error)).toBeNull();
  });

  test("recognises transport errors via numeric statusCode === 402", () => {
    const transportError = {
      statusCode: 402,
      message: "Usage limit exceeded: need 30, have 5",
      responseBody: JSON.stringify({
        reason: "usage_limit_exceeded",
        required: 30,
        available: 5,
      }),
    };
    const out = extractFromError(transportError);
    expect(out?.details).toEqual({
      reason: "usage_limit_exceeded",
      required: 30,
      available: 5,
    });
  });

  test("transport error with object responseBody (not stringified)", () => {
    const transportError = {
      statusCode: 402,
      message: "no entitlement",
      responseBody: { reason: "no_entitlement", required: 1, available: 0 },
    };
    expect(extractFromError(transportError)?.details).toEqual({
      reason: "no_entitlement",
      required: 1,
      available: 0,
    });
  });

  test("transport error with non-JSON responseBody is rejected (no marker)", () => {
    // Without our `reason` marker we cannot prove this 402 came
    // from our usage-limit gate vs. an upstream provider — decline.
    const transportError = {
      statusCode: 402,
      message: "usage limit",
      responseBody: "this is not json at all",
    };
    expect(extractFromError(transportError)).toBeNull();
  });

  test("returns null for transport error with non-402 statusCode", () => {
    expect(extractFromError({ statusCode: 500, message: "boom" })).toBeNull();
  });

  test("returns null for completely unrelated thrown values", () => {
    expect(extractFromError("plain string")).toBeNull();
    expect(extractFromError(undefined)).toBeNull();
    expect(extractFromError(null)).toBeNull();
    expect(extractFromError(42)).toBeNull();
  });

  test("transport 402 without our reason marker is declined", () => {
    // An upstream provider's 402 surfaced through transport
    // (OpenAI/Anthropic quota etc.) must NOT pop the modal —
    // the message would mislead the user into thinking it's a
    // Stella usage-limit gate when it isn't.
    const transportError = {
      statusCode: 402,
      message: "Quota exceeded",
      responseBody: JSON.stringify({ error: "upstream provider quota" }),
    };
    expect(extractFromError(transportError)).toBeNull();
  });

  test("array-shaped responseBody is rejected as not-a-plain-object", () => {
    // Defensive guard against parseResponseBody mis-typing arrays
    // as Record. Without a parseable object we cannot find our
    // reason marker → decline.
    const out = extractFromError({
      statusCode: 402,
      message: "limit",
      responseBody: JSON.stringify([1, 2, 3]),
    });
    expect(out).toBeNull();
  });
});
