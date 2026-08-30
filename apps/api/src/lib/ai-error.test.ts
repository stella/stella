import { describe, expect, test } from "bun:test";

import {
  classifyAIError,
  isAnticipatedAIFailure,
  providerStatusFields,
} from "@/api/lib/ai-error";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type {
  ChatTerminalError,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";

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

const tanStackRunError = (code: number) =>
  ({
    code: String(code),
    message: `provider responded ${code}`,
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

  test("prioritizes a provider cause over TanStack's transport wrapper", () => {
    const error = new HandlerError({
      cause: apiCallError(404),
      message: "generation failed",
      status: 502,
    });

    expect(classifyAIError(error)).toBe("model_unavailable");
  });

  test("stops at a cyclic cause chain", () => {
    const error: Record<string, unknown> = {};
    error["cause"] = error;

    expect(classifyAIError(error)).toBe("unknown");
  });

  test("maps a provider 401 to provider_credentials_rejected", () => {
    expect(classifyAIError(apiCallError(401))).toBe(
      "provider_credentials_rejected",
    );
    expect(classifyAIError(tanStackProviderError(401))).toBe(
      "provider_credentials_rejected",
    );
    expect(classifyAIError(tanStackRunError(401))).toBe(
      "provider_credentials_rejected",
    );
    expect(classifyAIError({ code: "invalid_api_key" })).toBe(
      "provider_credentials_rejected",
    );
    expect(
      classifyAIError({
        error: { type: "authentication_error" },
        type: "error",
      }),
    ).toBe("provider_credentials_rejected");
    expect(classifyAIError(providerErrorBody(401, "UNAUTHENTICATED"))).toBe(
      "provider_credentials_rejected",
    );
  });

  test("finds a rejected-credentials 401 through wrapped causes", () => {
    const error = new Error("stream failed", {
      cause: apiCallError(401),
    });

    expect(classifyAIError(error)).toBe("provider_credentials_rejected");
  });

  test("reads a 401 this service raised itself as its own refusal", () => {
    // `HandlerError` carries a `status` of its own, so its 401 reaches the
    // classifier looking like a provider status. Naming it would replace the
    // handler's curated copy with the provider's.
    const refusal = new HandlerError({
      status: 401,
      message: "refused with 401",
    });

    expect(classifyAIError(refusal)).toBe("unknown");
    expect(isAnticipatedAIFailure(refusal, classifyAIError(refusal))).toBe(
      true,
    );
  });

  test("keeps a provider 401 wrapped in TanStack's transport wrapper", () => {
    const error = new HandlerError({
      cause: apiCallError(401),
      message: "generation failed",
      status: 502,
    });

    expect(classifyAIError(error)).toBe("provider_credentials_rejected");
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
    expect(classifyAIError({ code: "model_not_found" })).toBe("unknown");
  });
});

// Split so the exhaustiveness alias below fails to compile when a status is
// added to `HandlerErrorStatusCode` without deciding which side it falls on.
const CLIENT_STATUS_CODES = [
  400, 401, 402, 403, 404, 409, 413, 422, 428, 429,
] as const satisfies readonly HandlerErrorStatusCode[];

const SERVER_STATUS_CODES = [
  500, 502, 503,
] as const satisfies readonly HandlerErrorStatusCode[];

type UncoveredStatusCode = Exclude<
  HandlerErrorStatusCode,
  (typeof CLIENT_STATUS_CODES)[number] | (typeof SERVER_STATUS_CODES)[number]
>;

// One instance per member of the union, bound to it in both directions: the
// mapped type stops compiling when a member has no matching instance here.
const CHAT_TERMINAL_ERRORS = {
  ChatEmptyCompletionError: new ChatEmptyCompletionError({
    message: "finished with zero output",
  }),
  ChatLoopDetectedError: new ChatLoopDetectedError({
    message: "repeated the same work",
  }),
} as const satisfies {
  readonly [Tag in ChatTerminalError["_tag"]]: Extract<
    ChatTerminalError,
    { readonly _tag: Tag }
  >;
};

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

  test("anticipates every terminal outcome the chat stream raises itself", () => {
    // The stream models each of these and recovers from it, so none is a
    // defect, including the ones the classifier cannot name: an error this
    // service constructed carries no provider status to classify by.
    for (const error of Object.values(CHAT_TERMINAL_ERRORS)) {
      expect(isAnticipatedAIFailure(error, "unknown")).toBe(true);
      expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(true);
    }
  });

  test("does not anticipate a shape the classifier cannot name", () => {
    const error = new Error("stream ended before completion");

    expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(false);
  });
});

describe("providerStatusFields", () => {
  test("reports the status behind a failure the classifier cannot name", () => {
    // A 403 is a status the classifier reads but maps to no kind, so it falls
    // to `unknown` and is logged as a defect. The body arrives as a plain
    // object, which `errorFingerprint` reduces to a bare `UnknownError`, so
    // this status is the only thing separating it from a failure that carried
    // no status at all.
    const error = providerErrorBody(403, "PERMISSION_DENIED");

    expect(classifyAIError(error)).toBe("unknown");
    expect(providerStatusFields(error)).toEqual({
      "error.provider.status": "403",
    });
  });

  test("reports a status reached through a wrapper's cause", () => {
    // `classifyAIError` walks the cause chain, so a wrapper around an unmapped
    // provider response is still logged as `unknown`. Reading only the outer
    // error would report no status for it, which is the shape this field
    // exists to tell apart from a failure that carried none.
    const wrapped = new Error("adapter call failed", {
      cause: providerErrorBody(403, "PERMISSION_DENIED"),
    });

    expect(classifyAIError(wrapped)).toBe("unknown");
    expect(providerStatusFields(wrapped)).toEqual({
      "error.provider.status": "403",
    });
  });

  test("ignores an integer outside the HTTP status range", () => {
    // A top-level `status` was previously taken on `Number.isInteger` alone,
    // so a sentinel zero was reported as though it were a real status.
    for (const status of [0, 600, -1]) {
      expect(providerStatusFields({ status })).toEqual({});
      expect(providerStatusFields({ statusCode: status })).toEqual({});
    }
  });

  test("stops at a cyclic cause chain without a status", () => {
    const error = new Error("cyclic wrapper");
    error.cause = error;

    expect(providerStatusFields(error)).toEqual({});
  });

  test("reports nothing when the failure carries no status", () => {
    expect(providerStatusFields(new Error("stream ended"))).toEqual({});
    expect(providerStatusFields("boom")).toEqual({});
    expect(providerStatusFields(undefined)).toEqual({});
  });

  test("carries the status and nothing else", () => {
    // Asserted as an exact key set and an exact value, not as the absence of a
    // substring: every fixture here embeds the status in its message, so a
    // helper that leaked the message would still satisfy a "does not contain"
    // check against any one literal.
    for (const [error, status] of [
      [apiCallError(503), "503"],
      [tanStackProviderError(429), "429"],
      [providerErrorBody(404, "NOT_FOUND"), "404"],
    ] as const) {
      expect(providerStatusFields(error)).toEqual({
        "error.provider.status": status,
      });
    }
  });
});
