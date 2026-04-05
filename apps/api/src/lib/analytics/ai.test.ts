import type {
  OnStepFinishEvent,
  OnStepStartEvent,
  OnToolCallFinishEvent,
} from "ai";
import { describe, expect, test } from "bun:test";

import type { Analytics } from "./types";

process.env.EMAIL_PROVIDER ??= "smtp";
process.env.GOTENBERG_PASSWORD ??= "gotenberg";
process.env.GOTENBERG_URL ??= "http://localhost:3003";
process.env.GOTENBERG_USERNAME ??= "gotenberg";
process.env.SMTP_HOST ??= "localhost";
process.env.SMTP_PORT ??= "1025";

const loadAIAnalytics = async () => await import("./ai");

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
      identify: () => void 0,
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

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic callback event for focused unit coverage
    callbacks.stepCallbacks.experimental_onStepStart?.({
      messages: [
        {
          content: [{ text: "Summarize this", type: "text" }],
          role: "user",
        },
      ],
      model: { modelId: "gpt-5.4-mini", provider: "openai" },
      stepNumber: 0,
    } as unknown as OnStepStartEvent);

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic callback event for focused unit coverage
    callbacks.stepCallbacks.experimental_onToolCallFinish?.({
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
    } as unknown as OnToolCallFinishEvent);

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic callback event for focused unit coverage
    callbacks.stepCallbacks.onStepFinish?.({
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
    } as unknown as OnStepFinishEvent);

    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("$ai_span");
    expect(events[1]?.event).toBe("$ai_generation");
    expect(events[1]?.properties?.$ai_trace_id).toBe("trace_123");
    expect(events[1]?.properties?.$ai_input).toEqual([
      {
        content: [{ text: "Summarize this", type: "text" }],
        role: "user",
      },
    ]);
    expect(events[1]?.properties?.$ai_output_choices).toEqual([
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
      identify: () => void 0,
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
      identify: () => void 0,
    };

    const callbacks = aiAnalyticsModule.createAIAnalyticsCallbacks({
      analytics,
      captureContent: false,
      feature: "analysis.debug",
      forceEnabled: true,
      traceId: "trace_789",
    });

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic callback event for focused unit coverage
    callbacks.stepCallbacks.experimental_onStepStart?.({
      messages: [
        {
          content: [{ text: "Sensitive prompt", type: "text" }],
          role: "user",
        },
      ],
      model: { modelId: "gpt-5.4-mini", provider: "openai" },
      stepNumber: 0,
    } as unknown as OnStepStartEvent);

    callbacks.captureError(new Error("stream failed"));

    expect(events).toHaveLength(1);
    expect(events[0]?.properties).not.toHaveProperty("$ai_input");
  });
});
