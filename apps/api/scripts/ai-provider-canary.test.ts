import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKProviderRoleSupported,
} from "@stll/ai-catalog";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

import {
  CanaryProviderRunError,
  createPdfCanaryMessages,
  errorSummary,
  isRetryableCanaryError,
  PDF_CANARY_TOKEN,
  pdfCanarySelection,
  requireWeeklyToolExecution,
  runCanaryProbe,
  toolRoundTripInputSchema,
  toolRoundTripInputSchemaForProvider,
  toolRoundTripPromptForProvider,
} from "./ai-provider-canary";
import { CANARY_PROVIDERS } from "./ai-provider-canary-config";

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
        optionalNote: { pattern: "a^", type: "string" },
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
        attempts: retryable ? 2 : 1,
        calls: retryable ? 2 : 1,
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
