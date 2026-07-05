import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseManualCallbackInput } from "./manual-callback.js";

describe("parseManualCallbackInput", () => {
  test("parses a full redirected URL", () => {
    const result = parseManualCallbackInput(
      "http://127.0.0.1:54321/callback?code=abc123&state=xyz789",
    );
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ code: "abc123", state: "xyz789" });
    }
  });

  test("trims surrounding whitespace from a pasted URL", () => {
    const result = parseManualCallbackInput(
      "  http://127.0.0.1/callback?code=abc123&state=xyz789  \n",
    );
    expect(Result.isOk(result)).toBe(true);
  });

  test("accepts a bare authorization code with no URL", () => {
    const result = parseManualCallbackInput("abc123");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ code: "abc123", state: undefined });
    }
  });

  test("rejects empty input", () => {
    expect(Result.isError(parseManualCallbackInput(""))).toBe(true);
    expect(Result.isError(parseManualCallbackInput("   "))).toBe(true);
  });

  test("surfaces an error= query parameter from the redirected URL", () => {
    const result = parseManualCallbackInput(
      "http://127.0.0.1/callback?error=access_denied&error_description=user+declined",
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("user declined");
    }
  });

  test("rejects a URL with no code parameter", () => {
    const result = parseManualCallbackInput(
      "http://127.0.0.1/callback?state=xyz789",
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("rejects an unparseable URL-like string", () => {
    const result = parseManualCallbackInput("http://");
    expect(Result.isError(result)).toBe(true);
  });
});
