import type { ChatMiddlewareContext, TokenUsage } from "@tanstack/ai";
import { describe, expect, spyOn, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { SERVER_ANALYTICS_EVENTS } from "./types";
import type { Analytics } from "./types";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["AI_PROVIDER"] = "openai";
process.env["OPENAI_API_KEY"] ??= "test-openai-instance-key";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const loadTanStackAIAnalytics = async () => await import("./tanstack-ai");

const orgId = toSafeId<"organization">("org_tanstack_analytics");
const userId = toSafeId<"user">("user_tanstack_analytics");
const workspaceId = toSafeId<"workspace">("workspace_tanstack_analytics");

const usage = {
  promptTokens: 1_000_000,
  completionTokens: 0,
  totalTokens: 1_000_000,
} satisfies TokenUsage;

const createOpenAIOrgAIConfig = (): OrgAIConfig => ({
  providers: [
    {
      apiKey: "test-openai-org-key",
      provider: "openai",
    },
  ],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
});

const createMiddlewareContext = ({
  deferred = [],
  iteration = 0,
  modelOptions,
  runId = "run_1",
}: {
  deferred?: Promise<unknown>[];
  iteration?: number;
  modelOptions?: Record<string, unknown>;
  runId?: string;
} = {}): ChatMiddlewareContext => ({
  activity: "chat",
  requestId: "request_1",
  streamId: "stream_1",
  runId,
  threadId: "thread_1",
  phase: "modelStream",
  iteration,
  chunkIndex: 0,
  abort: () => undefined,
  context: undefined,
  defer: (promise) => {
    deferred.push(promise);
  },
  provider: "openai",
  model: "gpt-5.4-mini",
  source: "server",
  streaming: true,
  systemPrompts: [],
  options: undefined,
  modelOptions,
  messageCount: 1,
  hasTools: true,
  currentMessageId: null,
  accumulatedContent: "",
  messages: [],
  createId: (prefix) => `${prefix}_1`,
  // The capability registry and accessors are part of TanStack's middleware
  // context contract, but the analytics callbacks under test read only the
  // plain context fields above, never the capability machinery.
  // SAFETY: stub registry; `CapabilityRegistry` is not publicly constructible
  // and the hooks never touch `capabilities`/`get`/`getOptional`/`provide`.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  capabilities: {} as unknown as ChatMiddlewareContext["capabilities"],
  get: () => {
    throw new Error("capability access is not exercised in these tests");
  },
  getOptional: () => undefined,
  provide: () => undefined,
});

describe("createTanStackAIAnalyticsCallbacks", () => {
  test("captures completion events from TanStack middleware hooks", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const events: Parameters<Analytics["capture"]>[0][] = [];
    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      distinctId: "user_123",
      feature: "chat.stream",
      orgAIConfig: createOpenAIOrgAIConfig(),
      properties: { workspace_id: "workspace_safe", unsafe: "drop" },
      traceId: "trace_complete",
    });
    const ctx = createMiddlewareContext();

    await callbacks.middleware.onAfterToolCall?.(ctx, {
      duration: 10,
      ok: true,
      result: { ok: true },
      tool: undefined,
      toolCall: {
        id: "tool_1",
        type: "function",
        function: { name: "search", arguments: "{}" },
      },
      toolCallId: "tool_1",
      toolName: "search",
    });
    await callbacks.middleware.onFinish?.(ctx, {
      content: "Done",
      duration: 4200,
      finishReason: "stop",
      usage,
    });

    expect(events).toHaveLength(2);
    const generation = events.find(
      (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGeneration,
    );
    expect(generation).toMatchObject({
      distinctId: "user_123",
      properties: {
        $ai_model: "gpt-5.4-mini",
        $ai_provider: "openai",
        feature: "chat.stream",
      },
    });
    // Privacy mode by construction: the standard event never carries prompt
    // or completion content.
    expect(generation?.properties).not.toHaveProperty("$ai_input");
    expect(generation?.properties).not.toHaveProperty("$ai_output_choices");
    const completed = events.find(
      (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
    );
    expect(completed).toMatchObject({
      distinctId: "user_123",
      event: SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
      properties: {
        feature: "chat.stream",
        model: "gpt-5.4-mini",
        model_key_source: "byok",
        provider: "openai",
        tool_count_bucket: "1",
        workspace_id: "workspace_safe",
      },
    });
    expect(completed?.properties).not.toHaveProperty("unsafe");
  });

  test("groups events by the analytics organization without usage metering", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const events: Parameters<Analytics["capture"]>[0][] = [];
    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    // Org-scoped but unmetered (fixed-cost feature): the analytics-only
    // organization id must group generation, completion, and failure events
    // exactly like the metering-derived id does.
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      feature: "case-law.analysis",
      organizationId: orgId,
      orgAIConfig: createOpenAIOrgAIConfig(),
      properties: { jurisdiction: "CZE" },
      traceId: "trace_grouped",
    });
    const ctx = createMiddlewareContext();

    await callbacks.middleware.onFinish?.(ctx, {
      content: "Done",
      duration: 4200,
      finishReason: "stop",
      usage,
    });
    callbacks.captureError(new Error("boom"));

    const eventNames = events.map((event) => event.event);
    expect(eventNames).toContain(SERVER_ANALYTICS_EVENTS.aiGeneration);
    expect(eventNames).toContain(SERVER_ANALYTICS_EVENTS.aiGenerationCompleted);
    for (const event of events) {
      expect(event.groups).toEqual({ organization: orgId });
    }
    // `jurisdiction` is a newly allowlisted safe property and must survive
    // into the completed event.
    const completed = events.find(
      (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
    );
    expect(completed?.properties).toMatchObject({ jurisdiction: "CZE" });
  });

  test("records usage through TanStack deferred side effects", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
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
        values: (values: unknown) => {
          insertedRows.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "usage_event_1" }],
            }),
          };
        },
      }),
    };
    const { safeDb } = createScopedDbMock(tx);
    const analytics: Analytics = {
      capture: () => undefined,
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      feature: "chat.stream",
      modelRole: "chat",
      traceId: "trace_usage",
      usageMetering: {
        actionType: "chat",
        organizationId: orgId,
        safeDb,
        serviceTier: "standard",
        userId,
        workspaceId,
      },
    });
    const deferred: Promise<unknown>[] = [];

    await callbacks.middleware.onUsage?.(
      createMiddlewareContext({ deferred }),
      usage,
    );
    await callbacks.middleware.onUsage?.(
      createMiddlewareContext({ deferred, iteration: 1 }),
      usage,
    );
    await callbacks.middleware.onUsage?.(
      createMiddlewareContext({ deferred, runId: "run_2" }),
      usage,
    );
    await Promise.all(deferred);

    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]).toMatchObject({
      actionType: "chat",
      isByok: false,
      idempotencyKey: "trace_usage:run_1:0",
      modelRole: "chat",
      organizationId: orgId,
      periodEnd,
      periodStart,
      serviceTier: "standard",
      traceId: "trace_usage",
      userId,
      workspaceId,
    });
    expect(insertedRows[1]).toMatchObject({
      idempotencyKey: "trace_usage:run_1:1",
      traceId: "trace_usage",
    });
    expect(insertedRows[2]).toMatchObject({
      idempotencyKey: "trace_usage:run_2:0",
      traceId: "trace_usage",
    });
  });

  test("rates consumption against the explicitly selected model", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const { usageUnitsFromTokens } = await import("@/api/lib/usage/unit-model");
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
        values: (values: unknown) => {
          insertedRows.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "usage_event_1" }],
            }),
          };
        },
      }),
    };
    const { safeDb } = createScopedDbMock(tx);
    const events: Parameters<Analytics["capture"]>[0][] = [];
    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      feature: "chat.stream",
      modelRole: "chat",
      orgAIConfig: createOpenAIOrgAIConfig(),
      selectedModelId: "openai::gpt-5.6",
      traceId: "trace_selected_model",
      usageMetering: {
        actionType: "chat",
        organizationId: orgId,
        safeDb,
        serviceTier: "standard",
        userId,
        workspaceId,
      },
    });
    const deferred: Promise<unknown>[] = [];

    await callbacks.middleware.onUsage?.(
      createMiddlewareContext({ deferred }),
      usage,
    );
    await callbacks.middleware.onFinish?.(createMiddlewareContext(), {
      content: "Done",
      duration: 4200,
      finishReason: "stop",
      usage,
    });
    await Promise.all(deferred);

    const ratedMicroUnits = (modelId: string) =>
      usageUnitsFromTokens({
        actionType: "chat",
        inputTokens: usage.promptTokens,
        isByok: true,
        modelId,
        outputTokens: usage.completionTokens,
        serviceTier: "standard",
      }).rawUsageMicroUnits;

    // The org config's chat role default is gpt-5.4-mini: metering and
    // analytics must both name the model that actually served the turn.
    expect(ratedMicroUnits("gpt-5.6")).not.toBe(
      ratedMicroUnits("gpt-5.4-mini"),
    );
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      rawUsageMicroUnits: ratedMicroUnits("gpt-5.6"),
    });
    expect(events[0]?.properties).toMatchObject({
      $ai_model: "gpt-5.6",
      $ai_provider: "openai",
    });
  });

  test("meters standard-tier fallback usage as standard", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
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
        values: (values: unknown) => {
          insertedRows.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "usage_event_1" }],
            }),
          };
        },
      }),
    };
    const { safeDb } = createScopedDbMock(tx);
    const analytics: Analytics = {
      capture: () => undefined,
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      feature: "chat.stream",
      modelRole: "chat",
      traceId: "trace_fallback_usage",
      usageMetering: {
        actionType: "chat",
        organizationId: orgId,
        safeDb,
        serviceTier: "flex",
        userId,
        workspaceId,
      },
    });
    const deferred: Promise<unknown>[] = [];

    await callbacks.middleware.onUsage?.(
      createMiddlewareContext({
        deferred,
        modelOptions: { service_tier: "default" },
      }),
      usage,
    );
    await Promise.all(deferred);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      idempotencyKey: "trace_fallback_usage:run_1:0",
      serviceTier: "standard",
      traceId: "trace_fallback_usage",
    });
  });

  test("deduplicates TanStack middleware and catch-path errors", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const events: Parameters<Analytics["capture"]>[0][] = [];
    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };
    const callbacks = createTanStackAIAnalyticsCallbacks({
      analytics,
      feature: "chat.stream",
      orgAIConfig: createOpenAIOrgAIConfig(),
      traceId: "trace_error",
    });
    const error = new Error("provider failed");

    await callbacks.middleware.onError?.(createMiddlewareContext(), {
      duration: 50,
      error,
    });
    callbacks.captureError(error);

    // One standard failure record plus one internal event; the catch-path
    // repeat must add neither.
    expect(events).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGeneration,
      ),
    ).toHaveLength(1);
    const failedEvent = events.find(
      (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
    );
    expect(failedEvent).toMatchObject({
      event: SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
      properties: {
        failure_reason: "provider",
        feature: "chat.stream",
        model: "gpt-5.4-mini",
        provider: "openai",
      },
    });
  });

  test("keeps model metadata lookup best-effort", async () => {
    const { env } = await import("@/api/env");
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const originalRequirePersonalAIKey = env.REQUIRE_PERSONAL_AI_KEY;
    const events: Parameters<Analytics["capture"]>[0][] = [];
    const analytics: Analytics = {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    };

    try {
      env.REQUIRE_PERSONAL_AI_KEY = true;

      const callbacks = createTanStackAIAnalyticsCallbacks({
        analytics,
        feature: "chat.suggested-prompts",
        traceId: "trace_missing_model",
      });
      const deferred: Promise<unknown>[] = [];
      const error = new Error("provider unavailable");

      callbacks.captureError(error);
      await callbacks.middleware.onUsage?.(
        createMiddlewareContext({ deferred }),
        usage,
      );

      expect(deferred).toHaveLength(0);
      expect(events).toHaveLength(2);
      const failedEvent = events.find(
        (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
      );
      expect(failedEvent).toMatchObject({
        event: SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
        properties: {
          failure_reason: "provider",
          feature: "chat.suggested-prompts",
        },
      });
      expect(failedEvent?.properties).not.toHaveProperty("model");
      expect(failedEvent?.properties).not.toHaveProperty("provider");
      // Without resolved model info the standard record still ships, just
      // without model attribution.
      const generation = events.find(
        (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGeneration,
      );
      expect(generation?.properties).not.toHaveProperty("$ai_model");
    } finally {
      env.REQUIRE_PERSONAL_AI_KEY = originalRequirePersonalAIKey;
    }
  });

  test("logs anticipated failures at WARN and unknown shapes at ERROR", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const { logger } = await import("@/api/lib/observability/logger");
    const errorSpy = spyOn(logger, "error");
    const warnSpy = spyOn(logger, "warn");

    try {
      createTanStackAIAnalyticsCallbacks({
        analytics: {
          capture: () => undefined,
          flush: async () => undefined,
          identifyOrganizationGroup: () => undefined,
        },
        feature: "chat.suggested_prompts",
        traceId: "trace_provider_unavailable",
      }).captureError({ status: 503 });
      createTanStackAIAnalyticsCallbacks({
        analytics: {
          capture: () => undefined,
          flush: async () => undefined,
          identifyOrganizationGroup: () => undefined,
        },
        feature: "chat.suggested_prompts",
        traceId: "trace_unknown",
      }).captureError(new Error("boom"));

      expect(warnSpy).toHaveBeenCalledWith(
        "tanstack_ai.generation.failed",
        expect.objectContaining({
          "ai.error_kind": "provider_unavailable",
        }),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "tanstack_ai.generation.failed",
        expect.objectContaining({ "ai.error_kind": "unknown" }),
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("logs a configuration refusal at WARN with its status", async () => {
    const { createTanStackAIAnalyticsCallbacks } =
      await loadTanStackAIAnalytics();
    const { classifyAIError } = await import("@/api/lib/ai-error");
    const { logger } = await import("@/api/lib/observability/logger");
    const { HandlerError } = await import("@/api/lib/errors/tagged-errors");
    // What the model resolver raises when the role has no key configured.
    const error = new HandlerError({
      status: 403,
      message: 'AI is not available for the "fast" role on this deployment.',
    });

    // The classifier names failures by provider status, so it cannot name
    // this one; severity must not follow from that alone.
    expect(classifyAIError(error)).toBe("unknown");

    const errorSpy = spyOn(logger, "error");
    const warnSpy = spyOn(logger, "warn");

    try {
      createTanStackAIAnalyticsCallbacks({
        analytics: {
          capture: () => undefined,
          flush: async () => undefined,
          identifyOrganizationGroup: () => undefined,
        },
        feature: "templates.suggestFields",
        traceId: "trace_byok_role",
      }).captureError(error);

      expect(errorSpy).not.toHaveBeenCalledWith(
        "tanstack_ai.generation.failed",
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "tanstack_ai.generation.failed",
        expect.objectContaining({
          "ai.error_kind": "unknown",
          "error.status_code": 403,
        }),
      );
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
