import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKProviderRoleSupported,
  MODEL_ROLES,
} from "@stll/ai-catalog";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  CanaryCredentialRejectedError,
  CanaryProviderRunError,
  CATALOG_SWEEP_BUDGET_MS,
  canaryCapabilityProbeTimeout,
  catalogModelIds,
  classifyCanaryFailure,
  createPdfCanaryMessages,
  CREDENTIAL_REJECTION_SIGNATURES,
  CREDENTIAL_REJECTION_STATUSES,
  errorSummary,
  isRetryableCanaryError,
  PDF_CANARY_TOKEN,
  pdfCanarySelection,
  requireWeeklyToolExecution,
  runCanaryProbe,
  runCanaryProbeSequence,
  runCatalogCanaryProbes,
  toolRoundTripInputSchema,
  toolRoundTripInputSchemaForProvider,
  toolRoundTripPromptForProvider,
} from "./ai-provider-canary";
import { CANARY_PROVIDERS } from "./ai-provider-canary-config";

describe("AI provider canary probe deadlines", () => {
  test("gives the budget-edge probe the extended structured-output deadline", () => {
    expect(
      canaryCapabilityProbeTimeout("structured-output-budget-edge"),
    ).toBe(45_000);
    expect(canaryCapabilityProbeTimeout("structured-output")).toBe(20_000);
    expect(canaryCapabilityProbeTimeout("unknown-probe")).toBeUndefined();
  });
});

describe("AI provider catalog canary coverage", () => {
  test("declares every selectable model id of a provider exactly once", () => {
    for (const provider of CANARY_PROVIDERS) {
      const ids = catalogModelIds(provider);
      expect(new Set(ids).size).toBe(ids.length);
      for (const role of MODEL_ROLES) {
        expect(ids).toContain(DEFAULT_MODELS[provider][role]);
      }
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        expect(ids).toContain(modelId);
      }
    }
  });

  test("the sweep probes exactly the declared ids, each once", async () => {
    for (const provider of CANARY_PROVIDERS) {
      const probed: string[] = [];
      // oxlint-disable-next-line no-await-in-loop -- providers run one at a time so the recorded order stays deterministic.
      const failures = await runCatalogCanaryProbes(
        {
          apiKey: "test-key",
          provider,
          probeModel: async ({ modelId, provider: probedProvider }) => {
            expect(probedProvider).toBe(provider);
            probed.push(modelId);
          },
        },
        0,
      );
      expect(failures).toBe(0);
      expect(probed).toEqual(catalogModelIds(provider));
    }
  });

  test("ids left when the sweep budget runs out fail instead of going unprobed", async () => {
    const provider = CANARY_PROVIDERS[0];
    const ids = catalogModelIds(provider);
    const probed: string[] = [];
    let clock = 0;
    const failures = await runCatalogCanaryProbes(
      {
        apiKey: "test-key",
        provider,
        now: () => clock,
        probeModel: async ({ modelId }) => {
          probed.push(modelId);
          // The first probe consumes the whole budget.
          clock += CATALOG_SWEEP_BUDGET_MS;
        },
      },
      0,
    );
    expect(probed).toEqual(ids.slice(0, 1));
    expect(failures).toBe(ids.length - 1);
  });
});

describe("AI provider canary overload backoff", () => {
  test("waits longer before each further attempt and gives an overloaded provider three tries", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await runCanaryProbe({
      retryDelayMs: 5000,
      run: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderStatusError(503);
        }
      },
      timeoutMs: 1000,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });
    expect(result).toEqual({ attempts: 3, status: "passed" });
    expect(waits).toEqual([5000, 20_000]);
  });
});

describe("AI provider PDF canary contract", () => {
  test("sends a real inline PDF rather than a text-only pdf-role probe", () => {
    const message = createPdfCanaryMessages().at(0);
    expect(message?.role).toBe("user");
    const content = message?.content;
    if (!Array.isArray(content)) {
      throw new TypeError("Expected multimodal PDF canary message");
    }

    const text = content.find((part) => part.type === "text");
    expect(text?.content).not.toContain(PDF_CANARY_TOKEN);
    const document = content.find((part) => part.type === "document");
    expect(document?.source.type).toBe("data");
    if (!document || document.source.type !== "data") {
      throw new Error("Expected inline PDF canary data");
    }

    const bytes = Buffer.from(document.source.value, "base64");
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(bytes.toString()).toContain(PDF_CANARY_TOKEN);
  });

  test("covers every provider with an available PDF attachment path", () => {
    for (const provider of CANARY_PROVIDERS) {
      const selection = pdfCanarySelection(provider);
      if (isBYOKProviderRoleSupported({ provider, role: "pdf" })) {
        expect(selection).toEqual({
          modelId: DEFAULT_MODELS[provider].pdf,
          role: "pdf",
        });
        continue;
      }

      const chatAttachmentModel =
        CHAT_PDF_ATTACHMENT_MODEL_OPTIONS[provider].at(0);
      expect(selection).toEqual(
        chatAttachmentModel === undefined
          ? null
          : { modelId: chatAttachmentModel, role: "chat" },
      );
    }

    expect(pdfCanarySelection("mistral")).toEqual({
      modelId: "mistral-medium-latest",
      role: "chat",
    });
  });
});

describe("AI provider canary tool contract", () => {
  test("keeps the omission marker outside the application schema", () => {
    const requiredInput = {
      count: 7,
      value: "stella-canary",
    };

    expect(v.safeParse(toolRoundTripInputSchema, requiredInput).success).toBe(
      true,
    );
    expect(
      v.safeParse(toolRoundTripInputSchema, {
        ...requiredInput,
        optionalNote: "any string",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(toolRoundTripInputSchema, {
        ...requiredInput,
        optionalNote: null,
      }).success,
    ).toBe(false);

    expect(
      toTanStackToolSchema(toolRoundTripInputSchema)[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }),
    ).toMatchObject({
      properties: {
        optionalNote: { maxLength: 0, type: "string" },
      },
      required: ["count", "value"],
    });
  });

  test("requests the provider representation used by each adapter", () => {
    expect(toolRoundTripPromptForProvider("openai")).toContain(
      "Set optionalNote to null.",
    );
    expect(toolRoundTripPromptForProvider("mistral")).toContain(
      "Set optionalNote to null.",
    );
    expect(toolRoundTripPromptForProvider("openrouter")).toContain(
      "Do not include optionalNote.",
    );
    expect(
      toolRoundTripInputSchemaForProvider("mistral")[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }),
    ).toMatchObject({
      properties: {
        optionalNote: { type: "string", enum: [] },
      },
      required: ["count", "value"],
    });
  });
});

describe("AI provider canary error summaries", () => {
  test("reports only bounded provider codes and the failed tool stage", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          { error: { code: "provider_error" } },
          "after-tool-result",
        ),
        signal,
      ),
    ).toBe("provider stream error after tool result (provider_error)");
  });

  test("does not include provider messages or unbounded code fields", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      {
        code: "unsafe code containing request material",
        message: "provider response body",
      },
      "before-tool-call",
    );

    expect(errorSummary(error, signal)).toBe(
      "provider stream error before tool call",
    );
    expect(
      errorSummary(
        new CanaryProviderRunError(
          { code: "client-matter-name" },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe("provider stream error before tool call");
  });

  // The OpenAI adapter reports a truncated or blocked response as this event
  // shape, putting `incomplete_details.reason` in both message positions.
  test("names the reason an incomplete stream carries", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          {
            code: "incomplete",
            message: "max_output_tokens",
            error: { code: "incomplete", message: "max_output_tokens" },
          },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe(
      "provider stream error before tool call (incomplete: max_output_tokens)",
    );

    expect(
      errorSummary(
        new CanaryProviderRunError(
          { error: { code: "incomplete", message: "content_filter" } },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe(
      "provider stream error before tool call (incomplete: content_filter)",
    );
  });

  test("keeps an unrecognized incomplete message out of the summary", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          {
            code: "incomplete",
            message: "Response ended incomplete: client matter name",
          },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe("provider stream error before tool call (incomplete)");
  });

  test("prefers a numeric provider status without exposing the event", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      { rawEvent: { statusCode: 429, body: "not logged" } },
      "after-tool-call",
    );

    expect(errorSummary(error, signal)).toBe("provider HTTP 429");
  });
});

class ProviderStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Synthetic provider HTTP ${status}`);
    this.name = "ProviderStatusError";
    this.status = status;
  }
}

describe("AI provider canary retry contract", () => {
  test("retries exactly once for every retryable HTTP status class", async () => {
    const statuses = [
      { retryable: false, status: 400 },
      { retryable: false, status: 401 },
      { retryable: false, status: 403 },
      { retryable: false, status: 422 },
      { retryable: true, status: 429 },
      { retryable: true, status: 500 },
      { retryable: true, status: 502 },
      { retryable: true, status: 503 },
    ];

    const outcomes = await Promise.all(
      statuses.map(async ({ retryable, status }) => {
        let calls = 0;
        const result = await runCanaryProbe({
          retryDelayMs: 0,
          run: async () => {
            calls += 1;
            throw new ProviderStatusError(status);
          },
          timeoutMs: 1000,
          wait: async () => {},
        });
        return { calls, result, retryable, status };
      }),
    );

    expect(
      outcomes.map(({ calls, result, retryable, status }) => ({
        attempts: result.attempts,
        calls,
        retryable,
        status,
      })),
    ).toEqual(
      statuses.map(({ retryable, status }) => ({
        attempts: retryable ? 3 : 1,
        calls: retryable ? 3 : 1,
        retryable,
        status,
      })),
    );
  });

  test("retries an opaque provider stream failure before succeeding", async () => {
    let calls = 0;
    const result = await runCanaryProbe({
      retryDelayMs: 0,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new CanaryProviderRunError({}, "before-tool-call");
        }
      },
      timeoutMs: 1000,
      wait: async () => {},
    });

    expect(result).toEqual({ attempts: 2, status: "passed" });
    expect(calls).toBe(2);
  });

  test("retries a known status-less transport failure before succeeding", async () => {
    let calls = 0;
    const result = await runCanaryProbe({
      retryDelayMs: 0,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed", {
            cause: { code: "ECONNRESET" },
          });
        }
      },
      timeoutMs: 1000,
      wait: async () => {},
    });

    expect(result).toEqual({ attempts: 2, status: "passed" });
    expect(calls).toBe(2);
  });

  test("does not retry deterministic contract failures", async () => {
    let calls = 0;
    const error = new TypeError(
      "Provider returned unexpected weekly canary tool arguments.",
    );
    const result = await runCanaryProbe({
      retryDelayMs: 0,
      run: async () => {
        calls += 1;
        throw error;
      },
      timeoutMs: 1000,
      wait: async () => {},
    });

    expect(result).toMatchObject({ attempts: 1, error, status: "failed" });
    expect(calls).toBe(1);
  });

  test("classifies only bounded provider codes as retryable", () => {
    const signal = new AbortController().signal;

    expect(
      isRetryableCanaryError(
        new CanaryProviderRunError(
          { error: { code: "provider_error" } },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe(true);
    expect(
      isRetryableCanaryError(
        new CanaryProviderRunError(
          { error: { code: "invalid_request_error" } },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe(false);
    expect(
      isRetryableCanaryError(
        new CanaryProviderRunError(
          { error: { code: "unknown_permanent_error" } },
          "before-tool-call",
        ),
        signal,
      ),
    ).toBe(false);
  });

  test("prefers a provider status nested beneath a generic transport wrapper", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      {
        cause: { code: "authentication_error", status: 401 },
        status: 502,
      },
      "before-tool-call",
    );

    expect(error.status).toBe(401);
    expect(error.code).toBe("authentication_error");
    expect(isRetryableCanaryError(error, signal)).toBe(false);
  });

  test("prefers terminal provider codes over a generic wrapper status", () => {
    const signal = new AbortController().signal;
    const errors = [
      { code: "invalid_request_error", status: 502 },
      { error: { code: "authentication_error" }, status: 502 },
      {
        cause: { code: "ECONNRESET" },
        code: "invalid_request_error",
        status: 502,
      },
      new CanaryProviderRunError(
        {
          cause: { code: "provider_error" },
          code: "permission_error",
          status: 502,
        },
        "before-tool-call",
      ),
    ];

    expect(
      errors.map((error) => isRetryableCanaryError(error, signal)),
    ).toEqual([false, false, false, false]);
  });

  test("classifies bounded message-only provider error bodies", () => {
    const signal = new AbortController().signal;
    const cases = [
      { body: { error: { code: 400 } }, retryable: false },
      { body: { error: { code: 402 } }, retryable: false },
      { body: { error: { code: 404 } }, retryable: false },
      { body: { error: { code: 429 } }, retryable: true },
      { body: { error: { code: 503 } }, retryable: true },
      { body: { code: "billing_error" }, retryable: false },
      { body: { code: "provider_error" }, retryable: true },
    ];

    const outcomes = cases.flatMap(({ body }) => {
      const message = `\n ${JSON.stringify(body)}`;
      return [
        isRetryableCanaryError(
          new CanaryProviderRunError({ message }, "before-tool-call"),
          signal,
        ),
        isRetryableCanaryError({ message, status: 502 }, signal),
      ];
    });

    expect(outcomes).toEqual(
      cases.flatMap(({ retryable }) => [retryable, retryable]),
    );
  });

  test("uses message bodies only when structured provider details are absent", () => {
    const signal = new AbortController().signal;
    const terminalMessage = JSON.stringify({ error: { code: 400 } });
    const cases = [
      new CanaryProviderRunError(
        {
          message: terminalMessage,
          rawEvent: { code: "provider_error", status: 503 },
        },
        "before-tool-call",
      ),
      {
        cause: { code: "provider_error", status: 503 },
        message: terminalMessage,
      },
      new CanaryProviderRunError({ message: "{malformed" }, "before-tool-call"),
      new CanaryProviderRunError(
        { message: "plain provider failure" },
        "before-tool-call",
      ),
    ];

    expect(cases.map((error) => isRetryableCanaryError(error, signal))).toEqual(
      [true, true, true, true],
    );
  });

  test("does not parse provider error messages beyond the size bound", () => {
    const signal = new AbortController().signal;
    const terminalBody = JSON.stringify({ error: { code: 400 } });
    const messages = [
      JSON.stringify({
        error: { code: 400 },
        padding: "x".repeat(20_000),
      }),
      `${" ".repeat(20_000)}${terminalBody}`,
    ];
    const errors = messages.flatMap((message) => [
      new CanaryProviderRunError({ message }, "before-tool-call"),
      { message, status: 502 },
    ]);

    expect(
      errors.map((error) => isRetryableCanaryError(error, signal)),
    ).toEqual([true, true, true, true]);
  });

  test("honors explicit retryability before HTTP status fallback", () => {
    const signal = new AbortController().signal;
    const cases = [
      { isRetryable: false, status: 429 },
      { retryable: false, status: 503 },
      { isRetryable: true, status: 400 },
      new CanaryProviderRunError(
        { retryable: false, status: 502 },
        "before-tool-call",
      ),
    ];

    expect(cases.map((error) => isRetryableCanaryError(error, signal))).toEqual(
      [false, false, true, false],
    );
  });

  test("classifies only known status-less transport errors and SDK markers", () => {
    const signal = new AbortController().signal;
    const cases = [
      { error: { cause: { code: "ECONNRESET" } }, retryable: true },
      { error: { code: "ETIMEDOUT" }, retryable: true },
      { error: { retryable: true }, retryable: true },
      { error: { $retryable: {} }, retryable: true },
      {
        error: { cause: { code: "ECONNRESET" }, isRetryable: false },
        retryable: false,
      },
      { error: { code: "EACCES" }, retryable: false },
    ];

    expect(
      cases.map(({ error }) => isRetryableCanaryError(error, signal)),
    ).toEqual(cases.map(({ retryable }) => retryable));
  });
});

// The shared generate path rethrows a provider RUN_ERROR as HTTP 502, keeping
// the provider message or the raw error body, so this is the exact shape an
// expired key reached the canary as.
class ProviderAuthError extends Error {
  readonly status = 502;
  readonly rawEvent: Record<string, unknown> | undefined;

  constructor(message: string, rawEvent?: Record<string, unknown>) {
    super(message);
    this.name = "ProviderAuthError";
    this.rawEvent = rawEvent;
  }
}

type CredentialSignatureField = "code" | "message" | "type";

// The adapter field each declared signature actually arrives on. One standalone
// fixture per signature keeps a removed matcher from being masked by a sibling
// match on the same error.
const CREDENTIAL_SIGNATURE_FIELDS = {
  "authentication failed": "message",
  authentication_error: "type",
  "invalid x-api-key": "message",
  invalid_api_key: "code",
  "incorrect api key": "message",
  "api key not valid": "message",
  permission_denied: "message",
  unauthenticated: "message",
  "no auth credentials found": "message",
  unauthorized: "message",
} as const satisfies Record<
  (typeof CREDENTIAL_REJECTION_SIGNATURES)[number],
  CredentialSignatureField
>;

const credentialFixture = (
  signature: string,
  field: CredentialSignatureField,
): ProviderAuthError =>
  field === "message"
    ? new ProviderAuthError(signature)
    : new ProviderAuthError("Provider request failed.", {
        error: { [field]: signature },
      });

const runProbeWithoutBackoff = async ({
  run,
  timeoutMs,
}: {
  run: (signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
}) =>
  await runCanaryProbe({
    retryDelayMs: 0,
    run,
    timeoutMs,
    wait: async () => {},
  });

describe("AI provider canary credential rejection", () => {
  test("classifies every declared signature on its own", () => {
    const exercised = Object.keys(CREDENTIAL_SIGNATURE_FIELDS);
    expect(new Set(exercised)).toEqual(
      new Set(CREDENTIAL_REJECTION_SIGNATURES),
    );

    for (const signature of CREDENTIAL_REJECTION_SIGNATURES) {
      const fixture = credentialFixture(
        signature,
        CREDENTIAL_SIGNATURE_FIELDS[signature],
      );
      expect(classifyCanaryFailure(fixture)).toEqual({
        kind: "credential-rejected",
        reason: signature,
      });
    }
  });

  test("treats a bare 403 as a provider failure, a bare 401 as a rejection", () => {
    // A valid key without entitlement to a model also answers 403.
    expect(classifyCanaryFailure({ status: 403 })).toEqual({
      kind: "provider-failure",
    });
    expect(
      classifyCanaryFailure({ status: 403, message: "PERMISSION_DENIED" }),
    ).toEqual({ kind: "credential-rejected", reason: "permission_denied" });
    for (const status of CREDENTIAL_REJECTION_STATUSES) {
      expect(classifyCanaryFailure({ status })).toEqual({
        kind: "credential-rejected",
        reason: `HTTP ${status}`,
      });
    }
  });

  test("summarizes auth statuses and adapter auth signatures as credential rejection", () => {
    const signal = new AbortController().signal;
    const credentialFailures = [
      // bedrock-converse: bearer-key rejection relayed as a RUN_ERROR message.
      new CanaryProviderRunError(
        {
          error: {
            message:
              "Authentication failed: Please make sure your API Key is valid.",
          },
        },
        "before-tool-call",
      ),
      // openai-base: 401 response body forwarded as rawEvent.
      new CanaryProviderRunError(
        {
          rawEvent: {
            error: {
              code: "invalid_api_key",
              message: "Incorrect API key provided: sk-***",
            },
          },
        },
        "before-tool-call",
      ),
      // ai-anthropic: SDK message carrying the error body.
      new CanaryProviderRunError(
        {
          message:
            '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        },
        "before-tool-call",
      ),
      new CanaryProviderRunError(
        { rawEvent: { statusCode: 401 } },
        "after-tool-call",
      ),
      // ai-gemini: rejection body rethrown by the shared generate path.
      new ProviderAuthError(
        '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
      ),
      // ai-gemini: restricted key, 403 alongside an auth signature.
      { status: 403, message: "PERMISSION_DENIED" },
    ];

    expect(
      credentialFailures.map((error) => errorSummary(error, signal)),
    ).toEqual(credentialFailures.map(() => "credential rejected"));
  });

  test("keeps capability failures out of the credential class", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          { error: { code: "provider_error" } },
          "after-tool-result",
        ),
        signal,
      ),
    ).toBe("provider stream error after tool result (provider_error)");
    expect(
      errorSummary(
        new ProviderAuthError("Upstream model is overloaded."),
        signal,
      ),
    ).toBe("provider HTTP 502");
  });

  test("does not retry a credential rejection wrapped in a retryable status", async () => {
    let calls = 0;
    const result = await runCanaryProbe({
      retryDelayMs: 0,
      run: async () => {
        calls += 1;
        throw new ProviderAuthError(
          "Authentication failed: Please make sure your API Key is valid.",
        );
      },
      timeoutMs: 1000,
      wait: async () => {},
    });

    expect(result.attempts).toBe(1);
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });

  test("aborts the remaining probes after a first-probe credential rejection", async () => {
    const invoked: string[] = [];
    const probeRuns = [
      "role-fast:model",
      "role-chat:model",
      "prompt-caching",
    ].map((label) => ({
      label,
      run: async () => {
        invoked.push(label);
        throw new ProviderAuthError(
          "Authentication failed: Please make sure your API Key is valid.",
        );
      },
      timeoutMs: 1000,
    }));

    const failure = await runCanaryProbeSequence({
      probeRuns,
      provider: "bedrock",
      runProbe: runProbeWithoutBackoff,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CanaryCredentialRejectedError);
    expect(failure).toHaveProperty(
      "message",
      "bedrock: credential rejected (role-fast:model, authentication failed); " +
        "rotate AI_CANARY_API_KEY for this provider",
    );
    expect(invoked).toEqual(["role-fast:model"]);
  });

  test("runs the remaining probes when the first probe fails for another reason", async () => {
    const invoked: string[] = [];
    const probeRuns = [
      "role-fast:model",
      "role-chat:model",
      "prompt-caching",
    ].map((label, index) => ({
      label,
      run: async () => {
        invoked.push(label);
        if (index === 0) {
          throw new TypeError("Provider returned no text.");
        }
      },
      timeoutMs: 1000,
    }));

    const failures = await runCanaryProbeSequence({
      probeRuns,
      provider: "bedrock",
      runProbe: runProbeWithoutBackoff,
    });

    expect(failures).toBe(1);
    expect(invoked).toEqual([
      "role-fast:model",
      "role-chat:model",
      "prompt-caching",
    ]);
  });
});

describe("AI provider weekly tool execution contract", () => {
  test("accepts valid execution without inspecting assistant wording", () => {
    const input = {
      details: { value: "stella-weekly" },
      type: "nested",
    };

    expect(() =>
      requireWeeklyToolExecution({
        expectedInputs: [input],
        observedInputs: [input],
      }),
    ).not.toThrow();
  });

  test("rejects every invalid execution cardinality and argument shape", () => {
    const input = {
      details: { value: "stella-weekly" },
      type: "nested",
    };
    const invalidExecutions = [
      {
        expectedMessage:
          "Provider did not execute the weekly canary tool exactly once.",
        observedInputs: [],
      },
      {
        expectedMessage:
          "Provider did not execute the weekly canary tool exactly once.",
        observedInputs: [input, input],
      },
      {
        expectedMessage:
          "Provider returned unexpected weekly canary tool arguments.",
        observedInputs: [{ details: { value: "unexpected" }, type: "nested" }],
      },
    ];

    for (const { expectedMessage, observedInputs } of invalidExecutions) {
      expect(() =>
        requireWeeklyToolExecution({
          expectedInputs: [input],
          observedInputs,
        }),
      ).toThrow(expectedMessage);
    }
  });
});

describe("AI provider canary provider rejections", () => {
  const signal = new AbortController().signal;
  // Shapes the shared generate path produces from a Bedrock RUN_ERROR.
  const limit = {
    message:
      "The maximum tokens you requested exceeds the model limit of 10000. Try again with a maximum tokens value that is lower than 10000.",
    status: 502,
  };
  const access = {
    message:
      "Model access is denied due to IAM user or service role is not authorized to perform the required operation.",
    status: 502,
  };

  test("summarises a wrapped preflight rejection with a fixed phrase", () => {
    expect(errorSummary(limit, signal)).toBe(
      "provider rejected request (output ceiling above model limit)",
    );
    expect(errorSummary(access, signal)).toBe(
      "provider rejected request (model access denied)",
    );
    expect(errorSummary({ error: limit }, signal)).toBe(
      "provider rejected request (output ceiling above model limit)",
    );
  });

  test("does not retry a preflight rejection", () => {
    expect(isRetryableCanaryError(limit, signal)).toBe(false);
    expect(isRetryableCanaryError(access, signal)).toBe(false);
  });

  test("keeps the reason on a streamed run error from a tool probe", () => {
    const streamed = new CanaryProviderRunError(
      { error: limit, message: limit.message },
      "before-tool-call",
    );
    expect(errorSummary(streamed, signal)).toBe(
      "provider rejected request (output ceiling above model limit)",
    );
    expect(isRetryableCanaryError(streamed, signal)).toBe(false);
  });
});

// The shared generate path rethrows provider RUN_ERRORs as a HandlerError
// whose 502 is the handler's own status; the canary must read the wrapped
// evidence instead of printing that wrapper.
describe("AI provider canary wrapped generate errors", () => {
  const signal = new AbortController().signal;

  test("names an Anthropic output-ceiling cut-off instead of the wrapper 502", () => {
    const cutOff = new HandlerError({
      status: 502,
      code: "max_tokens",
      message:
        "The response was cut off because the maximum token limit was reached.",
    });

    expect(errorSummary(cutOff, signal)).toBe("provider error (max_tokens)");
    expect(isRetryableCanaryError(cutOff, signal)).toBe(false);
  });

  test("reads a prefixed provider body for its status and rejection", () => {
    const tier = new HandlerError({
      status: 502,
      message:
        'Mistral API error 403: {"object":"error","message":"This model is not available in your subscription tier","type":"tier_not_allowed","param":null,"code":"1910","raw_status_code":403}',
    });

    expect(errorSummary(tier, signal)).toBe(
      "provider rejected request (model outside subscription tier)",
    );
    expect(isRetryableCanaryError(tier, signal)).toBe(false);
    expect(
      errorSummary(
        new HandlerError({
          status: 502,
          message:
            'Mistral API error 503: {"object":"error","message":"busy","type":"service_unavailable","raw_status_code":503}',
        }),
        signal,
      ),
    ).toBe("provider HTTP 503");
  });

  test("treats a terminal class carried in `type` as terminal despite a retryable status", () => {
    const cutOff = new CanaryProviderRunError(
      { rawEvent: { type: "max_tokens", raw_status_code: 503 } },
      "before-tool-call",
    );

    expect(isRetryableCanaryError(cutOff, signal)).toBe(false);
    expect(errorSummary(cutOff, signal)).toBe("provider HTTP 503 (max_tokens)");
  });

  test("keeps a wrapped Anthropic overload retryable with its class named", () => {
    const overloaded = new HandlerError({
      status: 502,
      code: "529",
      message: "529 Overloaded",
      cause: {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      },
    });

    expect(errorSummary(overloaded, signal)).toBe(
      "provider HTTP 529 (overloaded_error)",
    );
    expect(isRetryableCanaryError(overloaded, signal)).toBe(true);
  });
});
