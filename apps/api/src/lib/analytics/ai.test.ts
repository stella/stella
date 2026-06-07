import type {
  OnStepFinishEvent,
  OnStepStartEvent,
  OnToolCallFinishEvent,
} from "ai";
import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-models";
import { toSafeId } from "@/api/lib/branded-types";
import { asSdkEvent, asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { SERVER_ANALYTICS_EVENTS } from "./types";
import type { Analytics } from "./types";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["OPENAI_API_KEY"] ??= "test-openai-key";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const loadAIAnalytics = async () => await import("./ai");

const waitForAsyncSideEffects = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const setErrorCause = (error: Error, cause: unknown): Error => {
  Object.defineProperty(error, "cause", {
    configurable: true,
    value: cause,
  });
  return error;
};

const createErrorWithCause = (message: string, cause: unknown): Error =>
  setErrorCause(new Error(message), cause);

type TransportErrorOptions = {
  cause?: unknown;
  message: string;
  responseBody?: unknown;
  statusCode?: number;
};

const createTransportError = ({
  cause,
  message,
  responseBody,
  statusCode,
}: TransportErrorOptions): Error => {
  const error = Object.assign(new Error(message), {
    ...(responseBody === undefined ? {} : { responseBody }),
    ...(statusCode === undefined ? {} : { statusCode }),
  });

  if (cause !== undefined) {
    setErrorCause(error, cause);
  }

  return error;
};

const createGoogleOrgAIConfig = (): OrgAIConfig => ({
  providers: [
    {
      apiKey: "org-google-secret",
      provider: "google",
    },
  ],
  overrideModels: {
    chat: { provider: "google", modelId: "gemini-3.5-flash" },
    fast: { provider: "google", modelId: "gemini-3.5-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
    pdf: { provider: "google", modelId: "gemini-3.5-flash" },
  },
});

describe("sanitizeForAIAnalytics", () => {
  test("replaces binary payloads with summaries", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();
    expect(
      aiAnalyticsModule.sanitizeForAIAnalytics({
        data: new Uint8Array([1, 2, 3]),
        nested: [new ArrayBuffer(4)],
      }),
    ).toEqual({
      data: "[binary]",
      nested: ["[binary:4 bytes]"],
    });
  });

  test("truncates long strings", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();
    const long = "x".repeat(2100);
    expect(aiAnalyticsModule.sanitizeForAIAnalytics(long)).toBe(
      `${"x".repeat(1988)} [truncated]`,
    );
  });
});

describe("createAIAnalyticsCallbacks", () => {
  test("records per-step usage from actual token usage", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();
    const periodStart = new Date("2026-06-01T00:00:00.000Z");
    const periodEnd = new Date("2026-07-01T00:00:00.000Z");
    const insertedRows: unknown[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                currentPeriodEnd: periodEnd,
                currentPeriodStart: periodStart,
                status: "active",
              },
            ],
          }),
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          insertedRows.push(values);
        },
      }),
    };
    const { safeDb } = createScopedDbMock(tx);

    const analytics: Analytics = {
      capture: () => undefined,
      flush: async () => undefined,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      usageMetering: {
        actionType: "chat",
        organizationId: toSafeId<"organization">("org_usage"),
        safeDb,
        serviceTier: "standard",
        userId: toSafeId<"user">("user_usage"),
        workspaceId: toSafeId<"workspace">("workspace_usage"),
      },
      feature: "chat.stream",
      modelRole: "chat",
      traceId: "trace_usage",
    });

    callbacks.stepCallbacks.onStepFinish?.(
      asSdkEvent<OnStepFinishEvent>({
        content: [],
        dynamicToolCalls: [],
        dynamicToolResults: [],
        experimental_context: undefined,
        files: [],
        finishReason: "stop",
        functionId: undefined,
        metadata: undefined,
        model: { modelId: "gpt-4o-mini", provider: "openai" },
        providerMetadata: undefined,
        rawFinishReason: "stop",
        reasoning: [],
        reasoningText: undefined,
        request: {},
        response: {
          body: undefined,
          headers: undefined,
          id: "resp_usage",
          messages: [],
          modelId: "gpt-4o-mini",
          timestamp: new Date(),
        },
        sources: [],
        staticToolCalls: [],
        staticToolResults: [],
        stepNumber: 0,
        text: "",
        toolCalls: [],
        toolResults: [],
        usage: {
          inputTokenDetails: undefined,
          inputTokens: 1_000_000,
          outputTokenDetails: undefined,
          outputTokens: 0,
          totalTokens: 1_000_000,
        },
        warnings: undefined,
      }),
    );

    await waitForAsyncSideEffects();

    expect(insertedRows).toHaveLength(1);
    const row = asTestRaw<{
      actionType: string;
      unitsConsumed: number;
      isByok: boolean;
      modelRole: string;
      organizationId: string;
      periodEnd: Date;
      periodStart: Date;
      rawUsageMicroUnits: number;
      serviceTier: string;
      traceId: string;
      userId: string;
      workspaceId: string;
    }>(insertedRows.at(0));
    expect(row).toMatchObject({
      actionType: "chat",
      unitsConsumed: 225,
      isByok: false,
      modelRole: "chat",
      organizationId: "org_usage",
      periodEnd,
      periodStart,
      rawUsageMicroUnits: 15_000,
      serviceTier: "standard",
      traceId: "trace_usage",
      userId: "user_usage",
      workspaceId: "workspace_usage",
    });
  });

  test("captures generation and tool span events with sanitized content", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: {
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }[] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      captureContent: true,
      distinctId: "user_123",
      feature: "chat.debug",
      forceEnabled: true,
      properties: { workspace_id: "ws_123" },
      sessionId: "thread_123",
      traceId: "trace_123",
    });

    callbacks.stepCallbacks.experimental_onStepStart?.(
      asSdkEvent<OnStepStartEvent>({
        messages: [
          {
            content: [{ text: "Summarize this", type: "text" }],
            role: "user",
          },
        ],
        model: { modelId: "gpt-5.4-mini", provider: "openai" },
        stepNumber: 0,
      }),
    );

    callbacks.stepCallbacks.experimental_onToolCallFinish?.(
      asSdkEvent<OnToolCallFinishEvent>({
        abortSignal: undefined,
        durationMs: 120,
        error: undefined,
        experimental_context: undefined,
        functionId: undefined,
        messages: [],
        metadata: undefined,
        model: { modelId: "gpt-5.4-mini", provider: "openai" },
        output: { answer: "42" },
        stepNumber: 0,
        success: true,
        toolCall: {
          dynamic: false,
          input: { query: "life" },
          toolCallId: "tool_123",
          toolName: "search_docs",
        },
      }),
    );

    callbacks.stepCallbacks.onStepFinish?.(
      asSdkEvent<OnStepFinishEvent>({
        content: [],
        dynamicToolCalls: [],
        dynamicToolResults: [],
        experimental_context: undefined,
        files: [],
        finishReason: "stop",
        functionId: undefined,
        metadata: undefined,
        model: { modelId: "gpt-5.4-mini", provider: "openai" },
        providerMetadata: undefined,
        rawFinishReason: "stop",
        reasoning: [],
        reasoningText: undefined,
        request: {},
        response: {
          body: undefined,
          headers: undefined,
          id: "resp_123",
          messages: [
            {
              content: [{ text: "Done.", type: "text" }],
              role: "assistant",
            },
          ],
          modelId: "gpt-5.4-mini",
          timestamp: new Date(),
        },
        sources: [],
        staticToolCalls: [],
        staticToolResults: [],
        stepNumber: 0,
        text: "Done.",
        toolCalls: [
          {
            dynamic: false,
            input: {},
            toolCallId: "tool_123",
            toolName: "search_docs",
          },
        ],
        toolResults: [],
        usage: {
          inputTokenDetails: undefined,
          inputTokens: 10,
          outputTokenDetails: undefined,
          outputTokens: 4,
          totalTokens: 14,
        },
        warnings: undefined,
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("$ai_span");
    expect(events[1]?.event).toBe("$ai_generation");
    expect(events[1]?.properties?.["$ai_trace_id"]).toBe("trace_123");
    expect(events[1]?.properties?.["$ai_input"]).toEqual([
      {
        content: [{ text: "Summarize this", type: "text" }],
        role: "user",
      },
    ]);
    expect(events[1]?.properties?.["$ai_output_choices"]).toEqual([
      {
        content: [{ text: "Done.", type: "text" }],
        role: "assistant",
      },
    ]);
  });

  test("deduplicates generation errors captured from stream and catch paths", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: {
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }[] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.debug",
      forceEnabled: true,
      traceId: "trace_456",
    });

    callbacks.onStreamError?.({
      error: new Error("stream failed"),
    });
    callbacks.captureError(new Error("stream failed"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      distinctId: "local-debug:analysis.debug",
      event: "$ai_generation",
      properties: {
        $ai_is_error: true,
      },
    });
  });

  test("omits ai input from error events when content capture is disabled", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: {
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }[] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      captureContent: false,
      feature: "analysis.debug",
      forceEnabled: true,
      traceId: "trace_789",
    });

    callbacks.stepCallbacks.experimental_onStepStart?.(
      asSdkEvent<OnStepStartEvent>({
        messages: [
          {
            content: [{ text: "Sensitive prompt", type: "text" }],
            role: "user",
          },
        ],
        model: { modelId: "gpt-5.4-mini", provider: "openai" },
        stepNumber: 0,
      }),
    );

    callbacks.captureError(new Error("stream failed"));

    expect(events).toHaveLength(1);
    expect(events[0]?.properties).not.toHaveProperty("$ai_input");
  });

  test("captures basic aggregate generation without prompt or output content", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "chat.basic",
      modelRole: "fast",
      orgAIConfig: {
        providers: [
          {
            apiKey: "org-secret",
            provider: "openai",
          },
        ],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5.4-mini" },
          fast: { provider: "openai", modelId: "gpt-5.4-nano" },
          reasoning: { provider: "openai", modelId: "gpt-5.4" },
          pdf: { provider: "openai", modelId: "gpt-5.4" },
        },
      },
      properties: {
        entity_version_id: "ev_secret",
        organization_id: "org_123",
        workspace_id: "ws_123",
      },
      traceId: "trace_should_not_leave_basic_mode",
    });

    callbacks.stepCallbacks.experimental_onStepStart?.(
      asSdkEvent<OnStepStartEvent>({
        messages: [
          {
            content: [{ text: "Privileged client facts", type: "text" }],
            role: "user",
          },
        ],
        model: { modelId: "runtime-model", provider: "openai.responses" },
        stepNumber: 0,
      }),
    );

    callbacks.stepCallbacks.onStepFinish?.(
      asSdkEvent<OnStepFinishEvent>({
        content: [],
        dynamicToolCalls: [],
        dynamicToolResults: [],
        experimental_context: undefined,
        files: [],
        finishReason: "stop",
        functionId: undefined,
        metadata: undefined,
        model: { modelId: "runtime-model", provider: "openai.responses" },
        providerMetadata: undefined,
        rawFinishReason: "stop",
        reasoning: [],
        reasoningText: undefined,
        request: {},
        response: {
          body: undefined,
          headers: undefined,
          id: "resp_456",
          messages: [
            {
              content: [{ text: "Sensitive answer", type: "text" }],
              role: "assistant",
            },
          ],
          modelId: "runtime-model",
          timestamp: new Date(),
        },
        sources: [],
        staticToolCalls: [],
        staticToolResults: [],
        stepNumber: 0,
        text: "Sensitive answer",
        toolCalls: [],
        toolResults: [],
        usage: {
          inputTokenDetails: undefined,
          inputTokens: 1200,
          outputTokenDetails: undefined,
          outputTokens: 250,
          totalTokens: 1450,
        },
        warnings: undefined,
      }),
    );

    expect(events).toHaveLength(1);
    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationCompleted);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationCompleted) {
      throw new Error("Expected aggregate AI generation event");
    }
    expect(event.distinctId).toBe("server");
    expect(event.properties).toMatchObject({
      feature: "chat.basic",
      input_tokens_bucket: "1k_5k",
      model: "gpt-5.4-nano",
      model_key_source: "byok",
      organization_id: "org_123",
      output_tokens_bucket: "0_1k",
      provider: "openai",
      total_tokens_bucket: "1k_5k",
      workspace_id: "ws_123",
    });
    expect(event.properties).not.toHaveProperty("entity_version_id");
    expect(JSON.stringify(event.properties)).not.toContain("Privileged");
    expect(JSON.stringify(event.properties)).not.toContain("Sensitive answer");
    expect(JSON.stringify(event.properties)).not.toContain("trace_should_not");
  });

  test("captures basic aggregate failures without raw error messages", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      modelRole: "fast",
      orgAIConfig: {
        providers: [
          {
            apiKey: "org-secret",
            provider: "openai",
          },
        ],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5.4-mini" },
          fast: { provider: "openai", modelId: "gpt-5.4-nano" },
          reasoning: { provider: "openai", modelId: "gpt-5.4" },
          pdf: { provider: "openai", modelId: "gpt-5.4" },
        },
      },
      properties: {
        organization_id: "org_123",
        workspace_id: "ws_123",
      },
      traceId: "trace_should_not_leave_basic_mode",
    });

    callbacks.captureError(new Error("secret client name exceeded rate limit"));

    expect(events).toHaveLength(1);
    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties).toMatchObject({
      error_type: "Error",
      failure_reason: "rate_limit",
      feature: "analysis.basic",
      organization_id: "org_123",
      workspace_id: "ws_123",
    });
    expect(JSON.stringify(event.properties)).not.toContain("secret client");
    expect(JSON.stringify(event.properties)).not.toContain("trace_should_not");
  });

  test("captures safe provider messages from wrapped causes", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      traceId: "trace_wrapped_message",
    });

    callbacks.captureError(
      createErrorWithCause(
        "Failed after 3 attempts. Last error: quota failed",
        new Error("RESOURCE_EXHAUSTED: Quota exceeded for metric: requests"),
      ),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.error_message).toBe("RESOURCE_EXHAUSTED");
    expect(event.properties).not.toHaveProperty("error_message_kind");
    expect(JSON.stringify(event.properties)).not.toContain("Quota exceeded");
    expect(JSON.stringify(event.properties)).not.toContain("for metric");
  });

  test("buckets messages whose UPPER prefix is not on the provider allowlist", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      traceId: "trace_unknown_prefix",
    });

    callbacks.captureError(
      new Error("API: rejected '<<client memo trailing fragment>>'"),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.error_message_kind).toBe("non_standard");
    expect(event.properties).not.toHaveProperty("error_message");
    expect(JSON.stringify(event.properties)).not.toContain("client memo");
  });

  test("captures the deepest safe provider message within three cause levels", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      traceId: "trace_deep_message",
    });

    const fourthCause = new Error("UNAUTHENTICATED: outside search depth");
    const thirdCause = createErrorWithCause(
      "INVALID_ARGUMENT: deepest captured message",
      fourthCause,
    );
    const secondCause = createErrorWithCause(
      "RESOURCE_EXHAUSTED: shallower captured message",
      thirdCause,
    );
    const firstCause = createErrorWithCause(
      "PERMISSION_DENIED: shallow captured message",
      secondCause,
    );

    callbacks.captureError(
      createErrorWithCause("Failed after 3 attempts", firstCause),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.error_message).toBe("INVALID_ARGUMENT");
  });

  test("ignores safe provider messages beyond three cause levels", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      traceId: "trace_too_deep_message",
    });

    const fourthCause = new Error("RESOURCE_EXHAUSTED: outside search depth");
    const thirdCause = createErrorWithCause("wrapped", fourthCause);
    const secondCause = createErrorWithCause("wrapped", thirdCause);
    const firstCause = createErrorWithCause("wrapped", secondCause);

    callbacks.captureError(
      createErrorWithCause("Failed after 3 attempts", firstCause),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.error_message_kind).toBe("non_standard");
    expect(event.properties).not.toHaveProperty("error_message");
  });

  test("terminates provider message classification on cause cycles", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      traceId: "trace_cycle_message",
    });

    const cyclicError = new Error("Failed after 3 attempts");
    setErrorCause(cyclicError, cyclicError);
    callbacks.captureError(cyclicError);

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.error_message_kind).toBe("non_standard");
    expect(event.properties).not.toHaveProperty("error_message");
  });

  test("classifies wrapped Gemini BYOK quota exhaustion separately", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      modelRole: "fast",
      orgAIConfig: createGoogleOrgAIConfig(),
      traceId: "trace_byok_quota",
    });

    callbacks.captureError(
      createErrorWithCause(
        "Failed after 3 attempts. Last error: quota failed",
        createTransportError({
          message:
            "Quota exceeded for quota metric 'Generate requests per day per project per model'",
          responseBody:
            '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}}',
          statusCode: 429,
        }),
      ),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.failure_reason).toBe("byok_quota");
  });

  test("keeps shared-capacity Gemini resource exhaustion classified as rate limit", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      modelRole: "fast",
      orgAIConfig: createGoogleOrgAIConfig(),
      traceId: "trace_shared_capacity",
    });

    callbacks.captureError(
      createErrorWithCause(
        "Failed after 3 attempts. Last error: server capacity",
        createTransportError({
          message: "Resource exhausted, please try again later.",
          responseBody:
            '{"error":{"code":429,"message":"Resource exhausted, please try again later.","status":"RESOURCE_EXHAUSTED"}}',
          statusCode: 429,
        }),
      ),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.failure_reason).toBe("rate_limit");
  });

  test("keeps response body serialization failures from breaking classification", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const circularResponseBody: Record<string, unknown> = {
      status: "RESOURCE_EXHAUSTED",
    };
    circularResponseBody["self"] = circularResponseBody;

    const cases = [
      {
        message: "circular response body",
        responseBody: circularResponseBody,
      },
      {
        message: "bigint response body",
        responseBody: {
          remainingQuota: 0n,
          status: "RESOURCE_EXHAUSTED",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const events: Parameters<Analytics["capture"]>[0][] = [];

      const analytics: Analytics = {
        capture: (event) => {
          events.push(event);
        },
        flush: async () => void 0,
      };

      const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
        analytics,
        feature: "analysis.basic",
        modelRole: "fast",
        orgAIConfig: createGoogleOrgAIConfig(),
        traceId: `trace_${testCase.message}`,
      });

      callbacks.captureError(
        createTransportError({
          message: "Too many requests",
          responseBody: testCase.responseBody,
          statusCode: 429,
        }),
      );

      const event = events.at(0);
      expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
      if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
        throw new Error("Expected aggregate AI failure event");
      }
      expect(event.properties.failure_reason).toBe("rate_limit");
    }
  });

  test("keeps platform Gemini quota exhaustion classified as rate limit", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      modelRole: "fast",
      traceId: "trace_platform_quota",
    });

    callbacks.captureError(
      createErrorWithCause(
        "Failed after 3 attempts. Last error: quota failed",
        createTransportError({
          message:
            "Quota exceeded for quota metric 'Generate requests per day per project per model'",
          responseBody:
            '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}',
          statusCode: 429,
        }),
      ),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.failure_reason).toBe("rate_limit");
  });

  test("keeps non-quota 429 failures classified as rate limit", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const events: Parameters<Analytics["capture"]>[0][] = [];

    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      feature: "analysis.basic",
      modelRole: "fast",
      orgAIConfig: createGoogleOrgAIConfig(),
      traceId: "trace_non_quota_429",
    });

    callbacks.captureError(
      createErrorWithCause(
        "Failed after 3 attempts. Last error: rate limit",
        createTransportError({
          message: "Too many requests",
          responseBody: '{"error":{"code":429,"status":"RATE_LIMITED"}}',
          statusCode: 429,
        }),
      ),
    );

    const event = events.at(0);
    expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
    if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
      throw new Error("Expected aggregate AI failure event");
    }
    expect(event.properties.failure_reason).toBe("rate_limit");
  });

  test("classifies AI SDK statusCode transport failures", async () => {
    const aiAnalyticsModule = await loadAIAnalytics();

    const cases = [
      { error: { message: "request failed", statusCode: 401 }, reason: "auth" },
      {
        error: { message: "request failed", statusCode: 429 },
        reason: "rate_limit",
      },
      {
        error: { message: "request failed", statusCode: 504 },
        reason: "timeout",
      },
      {
        error: { message: "request failed", statusCode: 503 },
        reason: "provider",
      },
      { error: { message: "request failed", status: 403 }, reason: "auth" },
    ] as const;

    for (const testCase of cases) {
      const events: Parameters<Analytics["capture"]>[0][] = [];

      const analytics: Analytics = {
        capture: (event) => {
          events.push(event);
        },
        flush: async () => void 0,
      };

      const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
        analytics,
        feature: "analysis.basic",
        traceId: "trace_status_code",
      });

      callbacks.captureError(testCase.error);

      const event = events.at(0);
      expect(event?.event).toBe(SERVER_ANALYTICS_EVENTS.aiGenerationFailed);
      if (event?.event !== SERVER_ANALYTICS_EVENTS.aiGenerationFailed) {
        throw new Error("Expected aggregate AI failure event");
      }
      expect(event.properties.failure_reason).toBe(testCase.reason);
    }
  });
});
