import { APICallError } from "ai";
import { describe, expect, test } from "bun:test";

import { classifyAIError } from "@/api/lib/ai-error";
import { ChatLoopDetectedError } from "@/api/lib/errors/tagged-errors";

const apiCallError = (statusCode: number): APICallError =>
  new APICallError({
    message: `provider responded ${statusCode}`,
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    statusCode,
  });

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

  test("maps the AI SDK NoSuchModelError to model_unavailable", () => {
    const error = new Error("no such model: gpt-retired");
    error.name = "AI_NoSuchModelError";

    expect(classifyAIError(error)).toBe("model_unavailable");
  });

  test("still maps other status codes to their existing kinds", () => {
    expect(classifyAIError(apiCallError(429))).toBe("quota_exhausted");
    expect(classifyAIError(apiCallError(402))).toBe("usage_limit");
    expect(classifyAIError(apiCallError(503))).toBe("provider_unavailable");
  });
});
