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
});
