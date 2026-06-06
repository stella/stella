import { describe, expect, test } from "bun:test";

import {
  extractFromError,
  parseAmounts,
  reasonFromMessage,
} from "@/components/usage/use-usage-limit";
import { APIError } from "@/lib/errors";

describe("reasonFromMessage", () => {
  test("usage_limit_exceeded for messages that mention need / have amounts", () => {
    expect(reasonFromMessage("Usage limit exceeded: need 100, have 25")).toBe(
      "usage_limit_exceeded",
    );
  });

  test("no_entitlement for the API's no-entitlement message", () => {
    expect(
      reasonFromMessage("Organisation has no active usage entitlement"),
    ).toBe("no_entitlement");
  });

  test("entitlement_inactive for inactive entitlements", () => {
    expect(
      reasonFromMessage("Usage entitlement is paused and cannot consume units"),
    ).toBe("entitlement_inactive");
  });

  test("entitlement_inactive catches usage entitlement inactive wording", () => {
    expect(reasonFromMessage("Usage entitlement is inactive right now")).toBe(
      "entitlement_inactive",
    );
  });

  test("usage_limit_exceeded is the safe default for unrecognised messages", () => {
    expect(reasonFromMessage("some weird unrelated text")).toBe(
      "usage_limit_exceeded",
    );
  });

  test("matching is case-insensitive", () => {
    expect(
      reasonFromMessage("ORGANISATION HAS NO ACTIVE USAGE ENTITLEMENT"),
    ).toBe("no_entitlement");
  });
});

describe("extractFromError", () => {
  test("recognises an APIError with status 402", () => {
    const error = new APIError({
      status: 402,
      message: "Usage limit exceeded: need 50, have 10",
      details: { reason: "usage_limit_exceeded", required: 50, available: 10 },
    });
    const out = extractFromError(error);
    expect(out).not.toBeNull();
    expect(out?.message).toBe("Usage limit exceeded: need 50, have 10");
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

  test("recognises AI SDK errors via numeric statusCode === 402", () => {
    const sdkError = {
      name: "AI_APICallError",
      statusCode: 402,
      message: "Usage limit exceeded: need 30, have 5",
      responseBody: JSON.stringify({
        reason: "usage_limit_exceeded",
        required: 30,
        available: 5,
      }),
    };
    const out = extractFromError(sdkError);
    expect(out?.details).toEqual({
      reason: "usage_limit_exceeded",
      required: 30,
      available: 5,
    });
  });

  test("AI SDK error with object responseBody (not stringified)", () => {
    const sdkError = {
      statusCode: 402,
      message: "no entitlement",
      responseBody: { reason: "no_entitlement", required: 1, available: 0 },
    };
    expect(extractFromError(sdkError)?.details).toEqual({
      reason: "no_entitlement",
      required: 1,
      available: 0,
    });
  });

  test("AI SDK error with non-JSON responseBody is rejected (no marker)", () => {
    // Without our `reason` marker we cannot prove this 402 came
    // from our usage-limit gate vs. an upstream provider — decline.
    const sdkError = {
      statusCode: 402,
      message: "usage limit",
      responseBody: "this is not json at all",
    };
    expect(extractFromError(sdkError)).toBeNull();
  });

  test("returns null for AI SDK error with non-402 statusCode", () => {
    expect(extractFromError({ statusCode: 500, message: "boom" })).toBeNull();
  });

  test("returns null for completely unrelated thrown values", () => {
    expect(extractFromError("plain string")).toBeNull();
    expect(extractFromError(undefined)).toBeNull();
    expect(extractFromError(null)).toBeNull();
    expect(extractFromError(42)).toBeNull();
  });

  test("AI SDK 402 without our reason marker is declined", () => {
    // An upstream provider's 402 surfaced through the AI SDK
    // (OpenAI/Anthropic quota etc.) must NOT pop the modal —
    // the message would mislead the user into thinking it's a
    // Stella usage-limit gate when it isn't.
    const sdkError = {
      statusCode: 402,
      message: "Quota exceeded",
      responseBody: JSON.stringify({ error: "upstream provider quota" }),
    };
    expect(extractFromError(sdkError)).toBeNull();
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

describe("parseAmounts", () => {
  test("extracts required + available from the canonical message", () => {
    expect(parseAmounts("Usage limit exceeded: need 100, have 25")).toEqual({
      required: 100,
      available: 25,
    });
  });

  test("returns zeros when no numbers are present", () => {
    expect(parseAmounts("Usage entitlement is paused")).toEqual({
      required: 0,
      available: 0,
    });
  });

  test("handles whitespace variations", () => {
    expect(parseAmounts("need   100,   have   25")).toEqual({
      required: 100,
      available: 25,
    });
  });

  test("returns zeros if only one of the two numbers is present", () => {
    expect(parseAmounts("need 100")).toEqual({
      required: 0,
      available: 0,
    });
  });
});
