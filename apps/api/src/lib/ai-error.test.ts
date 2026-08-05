import { describe, expect, test } from "bun:test";

import { classifyAIError, isAnticipatedAIFailure } from "@/api/lib/ai-error";
import {
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";

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

const providerErrorBody = (code: number, status: string) =>
  ({
    error: {
      code,
      message: `provider responded ${code}`,
      status,
    },
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

  test("reads the status from a nested provider error body", () => {
    expect(classifyAIError(providerErrorBody(503, "UNAVAILABLE"))).toBe(
      "provider_unavailable",
    );
    expect(classifyAIError(providerErrorBody(429, "RESOURCE_EXHAUSTED"))).toBe(
      "quota_exhausted",
    );
    expect(classifyAIError(providerErrorBody(402, "PAYMENT_REQUIRED"))).toBe(
      "provider_billing",
    );
    expect(classifyAIError(providerErrorBody(404, "NOT_FOUND"))).toBe(
      "model_unavailable",
    );
  });

  test("finds a nested provider error body through wrapped causes", () => {
    const error = new Error("stream failed", {
      cause: providerErrorBody(503, "UNAVAILABLE"),
    });

    expect(classifyAIError(error)).toBe("provider_unavailable");
  });

  test("ignores a nested code that is not an HTTP status", () => {
    // OpenAI-shaped bodies put a symbolic code where Google puts the status,
    // and gRPC-shaped ones put a small application code there.
    expect(
      classifyAIError({
        error: { code: "insufficient_quota", message: "out of credits" },
      }),
    ).toBe("unknown");
    expect(
      classifyAIError({ error: { code: 14, message: "unavailable" } }),
    ).toBe("unknown");
  });
});

// Split so the exhaustiveness alias below fails to compile when a status is
// added to `HandlerErrorStatusCode` without deciding which side it falls on.
const CLIENT_STATUS_CODES = [
  400, 401, 402, 403, 404, 409, 413, 422, 429,
] as const satisfies readonly HandlerErrorStatusCode[];

const SERVER_STATUS_CODES = [
  500, 502,
] as const satisfies readonly HandlerErrorStatusCode[];

type UncoveredStatusCode = Exclude<
  HandlerErrorStatusCode,
  (typeof CLIENT_STATUS_CODES)[number] | (typeof SERVER_STATUS_CODES)[number]
>;

describe("isAnticipatedAIFailure", () => {
  test("exercises every HandlerError status", () => {
    // The guard is the annotation, which stops compiling while a status is
    // unaccounted for; the assertion just gives it a home.
    const everyStatusCovered: [UncoveredStatusCode] extends [never]
      ? true
      : false = true;

    expect(everyStatusCovered).toBe(true);
  });

  test("anticipates every client-actionable HandlerError", () => {
    // These are raised by the AI stack itself for a configuration state, so
    // none of them is a defect, including the ones the classifier cannot
    // name (such as the 403 for a role with no key configured).
    for (const status of CLIENT_STATUS_CODES) {
      const error = new HandlerError({
        status,
        message: `refused with ${status}`,
      });

      expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(true);
    }
  });

  test("leaves a server-side HandlerError to the classifier", () => {
    for (const status of SERVER_STATUS_CODES) {
      const error = new HandlerError({
        status,
        message: `failed with ${status}`,
      });
      const kind = classifyAIError(error);

      expect(isAnticipatedAIFailure(error, kind)).toBe(kind !== "unknown");
    }
  });

  test("does not anticipate a shape the classifier cannot name", () => {
    const error = new Error("stream ended before completion");

    expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(false);
  });
});
