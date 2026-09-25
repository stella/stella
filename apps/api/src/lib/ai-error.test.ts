import {
  AccessDeniedException,
  BedrockRuntimeServiceException,
  ConflictException,
  InternalServerException,
  ModelErrorException,
  ModelNotReadyException,
  ModelStreamErrorException,
  ModelTimeoutException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock-runtime";
import * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, test } from "bun:test";

import {
  classifyAIError,
  isAnticipatedAIFailure,
  isUnanticipatedAIFailure,
  providerStatusCode,
  providerStatusFields,
} from "@/api/lib/ai-error";
import type { AIErrorKind } from "@/api/lib/ai-error";
import {
  AIGenerationCancelledError,
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

// The transport wrapper the AI stack raises for a provider RUN_ERROR: its own
// status is a fixed 502 and the provider's status rides on `code`. An adapter
// forwards the structured body as `rawEvent` only when the SDK exception
// exposes one, so the code is often all the wrapper carries.
const wrappedRunError = (code: number) =>
  new HandlerError({
    ...tanStackRunError(code),
    status: 502,
  });

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

  test("names the provider status the transport wrapper carries as its code", () => {
    expect(classifyAIError(wrappedRunError(429))).toBe("quota_exhausted");
    expect(classifyAIError(wrappedRunError(402))).toBe("provider_billing");
    expect(classifyAIError(wrappedRunError(404))).toBe("model_unavailable");
    expect(classifyAIError(wrappedRunError(401))).toBe(
      "provider_credentials_rejected",
    );
    expect(classifyAIError(wrappedRunError(503))).toBe("provider_unavailable");
  });

  test("does not read the transport wrapper's own status as the provider's", () => {
    // The 502 is this service's, chosen for any run error alike, so it is
    // evidence of nothing: naming it would report a provider outage for a
    // failure that never said what went wrong.
    const error = new HandlerError({
      message: "generation failed",
      status: 502,
    });

    expect(classifyAIError(error)).toBe("unknown");
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

  test("anticipates a cancelled generation behind its 502", () => {
    // The generation helper rejects a run whose caller-supplied abort signal
    // fired (a deadline that caller set, or a client that went away) and
    // answers 502, so the status test alone would read a routine cancellation
    // as a defect. The classifier cannot name it either: an error this
    // service constructed carries no provider status to classify by.
    const cancelled = new HandlerError({
      status: 502,
      message: "AI generation was cancelled",
      cause: new AIGenerationCancelledError({
        message: "AI generation was cancelled",
      }),
    });

    expect(classifyAIError(cancelled)).toBe("unknown");
    expect(isAnticipatedAIFailure(cancelled, classifyAIError(cancelled))).toBe(
      true,
    );
  });

  test("does not anticipate an unnamed 502 carrying an unrelated cause", () => {
    // Only the cancellation tag is forgiven at 502. A wrapped cause the
    // classifier cannot name stays a defect, so the branch above cannot
    // quietly absorb every wrapped server-side failure.
    const error = new HandlerError({
      status: 502,
      message: "generation failed",
      cause: new Error("stream ended before completion"),
    });

    expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(false);
  });

  test("does not anticipate a shape the classifier cannot name", () => {
    const error = new Error("stream ended before completion");

    expect(isAnticipatedAIFailure(error, classifyAIError(error))).toBe(false);
  });
});

// A provider status that never met the AI boundary is unclassified: the
// record helpers grade in shadow, with no sink and no boundary decision.
const UNCLASSIFIED_SHADOW = {
  "failure.shadow_grade": "defect",
  "failure.shadow_reason": "unclassified",
} as const;

describe("providerStatusFields", () => {
  test("reads a numeric top-level code from an OpenRouter raw event", () => {
    const rawEvent = {
      code: 400,
      message: "Provider returned error",
      metadata: { raw: { provider: "openrouter" } },
    };

    expect(providerStatusCode(rawEvent)).toBe(400);
    expect(classifyAIError(rawEvent)).toBe("unknown");
    expect(providerStatusFields(rawEvent)).toEqual({
      "error.provider.status": "400",
      ...UNCLASSIFIED_SHADOW,
    });
  });

  test("accepts every HTTP-range numeric code and rejects non-status codes", () => {
    const validStatuses = [100, 200, 400, 429, 500, 599];
    for (const status of validStatuses) {
      expect(providerStatusCode({ code: status })).toBe(status);
    }

    for (const code of [Number.NaN, Number.POSITIVE_INFINITY, 99, 600, 400.5]) {
      expect(providerStatusCode({ code })).toBeNull();
    }
  });

  test("does not read a HandlerError's service status as provider code", () => {
    const error = new HandlerError({
      status: 502,
      message: "generation failed",
    });

    expect(providerStatusCode(error)).toBeNull();
    expect(providerStatusFields(error)).toEqual({});
  });

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
      ...UNCLASSIFIED_SHADOW,
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
      ...UNCLASSIFIED_SHADOW,
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
      // The wrapper's fixed 502 would report an outage for an unmapped
      // provider status; the code it carries is the one the classifier read.
      [wrappedRunError(403), "403"],
    ] as const) {
      expect(providerStatusFields(error)).toEqual({
        "error.provider.status": status,
        ...UNCLASSIFIED_SHADOW,
      });
    }
  });
});

describe("isUnanticipatedAIFailure", () => {
  test("classifies the error itself rather than taking a kind", () => {
    // The convenience form exists for catch blocks that never classified the
    // error, so it must agree with the guard on every input the guard sees.
    const cases: unknown[] = [
      new HandlerError({
        status: 502,
        message: "AI generation was cancelled",
        cause: new AIGenerationCancelledError({
          message: "AI generation was cancelled",
        }),
      }),
      new HandlerError({ status: 403, message: "no key for role" }),
      new HandlerError({ status: 502, message: "generation failed" }),
      new ChatEmptyCompletionError({ message: "no content" }),
      apiCallError(429),
      new Error("stream ended before completion"),
    ];

    for (const error of cases) {
      expect(isUnanticipatedAIFailure(error)).toBe(
        !isAnticipatedAIFailure(error, classifyAIError(error)),
      );
    }
  });

  test("does not report a cancelled generation", () => {
    // A cancelled run is the caller's own deadline or a client that went
    // away. It answers 502, so only the cause tells a defect sink apart from
    // a generation that genuinely broke.
    const cancelled = new HandlerError({
      status: 502,
      message: "AI generation was cancelled",
      cause: new AIGenerationCancelledError({
        message: "AI generation was cancelled",
      }),
    });

    expect(isUnanticipatedAIFailure(cancelled)).toBe(false);
  });

  test("reports a 502 the cancellation tag does not explain", () => {
    const error = new HandlerError({
      status: 502,
      message: "AI generation did not complete",
    });

    expect(isUnanticipatedAIFailure(error)).toBe(true);
  });
});

// Bedrock is reached through the AWS SDK, whose service exceptions carry the
// HTTP status at `$metadata.httpStatusCode`, a `$fault` side and the exception
// name. An exception thrown in-band from a Converse event stream carries the
// name and `$fault` but no HTTP status.
const bedrockMetadata = (httpStatusCode?: number) =>
  httpStatusCode === undefined ? {} : { httpStatusCode };

const BEDROCK_EXCEPTION_CASES = [
  {
    error: new AccessDeniedException({
      $metadata: bedrockMetadata(403),
      message: "You don't have access to the model",
    }),
    kind: "unknown",
  },
  {
    error: new ConflictException({
      $metadata: bedrockMetadata(400),
      message: "Conflict",
    }),
    kind: "unknown",
  },
  {
    error: new InternalServerException({
      $metadata: bedrockMetadata(500),
      message: "Internal server error",
    }),
    kind: "provider_unavailable",
  },
  {
    error: new ModelErrorException({
      $metadata: bedrockMetadata(424),
      message: "The model failed to process the request",
    }),
    kind: "unknown",
  },
  {
    error: new ModelNotReadyException({
      $metadata: bedrockMetadata(429),
      message: "Model is not ready",
    }),
    kind: "provider_unavailable",
  },
  {
    error: new ModelStreamErrorException({
      $metadata: bedrockMetadata(424),
      message: "Stream error",
    }),
    kind: "provider_unavailable",
  },
  {
    error: new ModelTimeoutException({
      $metadata: bedrockMetadata(408),
      message: "Model timed out",
    }),
    kind: "provider_unavailable",
  },
  {
    error: new ResourceNotFoundException({
      $metadata: bedrockMetadata(404),
      message: "Model not found",
    }),
    kind: "model_unavailable",
  },
  {
    error: new ServiceQuotaExceededException({
      $metadata: bedrockMetadata(400),
      message: "Service quota exceeded",
    }),
    kind: "quota_exhausted",
  },
  {
    error: new ServiceUnavailableException({
      $metadata: bedrockMetadata(503),
      message: "Service unavailable",
    }),
    kind: "provider_unavailable",
  },
  {
    error: new ThrottlingException({
      $metadata: bedrockMetadata(429),
      message: "Too many requests",
    }),
    kind: "quota_exhausted",
  },
  {
    error: new ValidationException({
      $metadata: bedrockMetadata(400),
      message: "Malformed input request",
    }),
    kind: "unknown",
  },
] as const satisfies readonly {
  error: BedrockRuntimeServiceException;
  kind: AIErrorKind;
}[];

describe("AWS SDK service exceptions", () => {
  test("every Bedrock runtime exception has a decided kind", () => {
    // A new exception in an SDK release fails here until it is given one.
    const exported = Object.values(BedrockRuntime)
      .flatMap((value) =>
        typeof value === "function" &&
        value.prototype instanceof BedrockRuntimeServiceException
          ? [value.name]
          : [],
      )
      .toSorted();

    expect(
      BEDROCK_EXCEPTION_CASES.map(({ error }): string => error.name).toSorted(),
    ).toEqual(exported);
  });

  test("names each exception at its HTTP status", () => {
    for (const { error, kind } of BEDROCK_EXCEPTION_CASES) {
      expect({ name: error.name, kind: classifyAIError(error) }).toEqual({
        name: error.name,
        kind,
      });
      expect(providerStatusFields(error)).toEqual({
        "error.provider.status": String(error.$metadata.httpStatusCode),
        ...UNCLASSIFIED_SHADOW,
      });
    }
  });

  test("names an in-band stream exception that carries no status", () => {
    const throttled = new ThrottlingException({
      $metadata: bedrockMetadata(),
      message: "Too many requests",
    });
    const unavailable = new ServiceUnavailableException({
      $metadata: bedrockMetadata(),
      message: "Service unavailable",
    });

    expect(classifyAIError(throttled)).toBe("quota_exhausted");
    expect(classifyAIError(unavailable)).toBe("provider_unavailable");
    expect(providerStatusCode(throttled)).toBeNull();
    expect(providerStatusFields(throttled)).toEqual({});
  });

  test("keeps access denied and validation failures unnamed", () => {
    // A 403 is ambiguous (model access, region, account state) and a 400 is
    // this request's own shape, so neither is given a kind; the status is
    // still logged so the failure sink can tell them apart.
    const denied = new AccessDeniedException({
      $metadata: bedrockMetadata(403),
      message: "You don't have access to the model",
    });
    const invalid = new ValidationException({
      $metadata: bedrockMetadata(400),
      message: "Malformed input request",
    });

    expect(classifyAIError(denied)).toBe("unknown");
    expect(providerStatusFields(denied)).toEqual({
      "error.provider.status": "403",
      ...UNCLASSIFIED_SHADOW,
    });
    expect(classifyAIError(invalid)).toBe("unknown");
    expect(providerStatusFields(invalid)).toEqual({
      "error.provider.status": "400",
      ...UNCLASSIFIED_SHADOW,
    });
  });

  test("reads the exception through the wrappers the AI stack adds", () => {
    const throttled = new ThrottlingException({
      $metadata: bedrockMetadata(429),
      message: "Too many requests",
    });
    // `chat({ outputSchema })` rethrows as `new Error(message, { cause })`;
    // the generation helper answers with a 502 `HandlerError`.
    const wrappers = [
      new Error(throttled.message, { cause: throttled }),
      new HandlerError({
        status: 502,
        message: throttled.message,
        cause: throttled,
      }),
    ];

    for (const wrapped of wrappers) {
      expect(classifyAIError(wrapped)).toBe("quota_exhausted");
      expect(providerStatusFields(wrapped)).toEqual({
        "error.provider.status": "429",
        ...UNCLASSIFIED_SHADOW,
      });
    }
  });

  test("ignores a metadata status outside the HTTP range", () => {
    for (const httpStatusCode of [0, 99, 600]) {
      const error = new ValidationException({
        $metadata: bedrockMetadata(httpStatusCode),
        message: "Malformed input request",
      });

      expect(providerStatusCode(error)).toBeNull();
      expect(providerStatusFields(error)).toEqual({});
    }
  });

  test("does not name a plain error that only shares an exception name", () => {
    const error = new Error("Too many requests");
    error.name = "ThrottlingException";

    expect(classifyAIError(error)).toBe("unknown");
  });
});
