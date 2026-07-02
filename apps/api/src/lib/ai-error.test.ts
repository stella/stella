import { describe, expect, test } from "bun:test";

import { classifyAIError } from "@/api/lib/ai-error";
import { ChatLoopDetectedError } from "@/api/lib/errors/tagged-errors";

const apiCallError = (statusCode: number) =>
  ({
    statusCode,
    message: `provider responded ${statusCode}`,
  }) satisfies Record<string, unknown>;

const tanStackProviderError = (status: number) =>
  ({
    status,
    message: `provider responded ${status}`,
  }) satisfies Record<string, unknown>;

describe("classifyAIError", () => {
  test("maps chat loop stops to a stable stream error kind", () => {
    const error = new ChatLoopDetectedError({
      message:
        "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
    });

    expect(classifyAIError(error)).toBe("loop_detected");
  });

  test("finds chat loop stops through wrapped causes", () => {
    const error = new Error("stream failed", {
      cause: new ChatLoopDetectedError({
        message:
          "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
      }),
    });

    expect(classifyAIError(error)).toBe("loop_detected");
  });

  test("maps a provider 404 to model_unavailable (retired/renamed model)", () => {
    expect(classifyAIError(apiCallError(404))).toBe("model_unavailable");
  });

  test("finds a model-not-found 404 through wrapped causes", () => {
    const error = new Error("generation failed", {
      cause: apiCallError(404),
    });

    expect(classifyAIError(error)).toBe("model_unavailable");
  });

  test("still maps other status codes to their existing kinds", () => {
    expect(classifyAIError(apiCallError(429))).toBe("quota_exhausted");
    expect(classifyAIError(apiCallError(402))).toBe("provider_billing");
    expect(classifyAIError(apiCallError(503))).toBe("provider_unavailable");
  });

  test("maps provider status fields without provider-specific error classes", () => {
    expect(classifyAIError(tanStackProviderError(429))).toBe("quota_exhausted");
    expect(classifyAIError(tanStackProviderError(402))).toBe(
      "provider_billing",
    );
    expect(classifyAIError(tanStackProviderError(404))).toBe(
      "model_unavailable",
    );
    expect(classifyAIError(tanStackProviderError(503))).toBe(
      "provider_unavailable",
    );
  });
});
