import type { ChatMiddlewareContext, TokenUsage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

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

const createMiddlewareContext = (
  deferred: Promise<unknown>[] = [],
): ChatMiddlewareContext => ({
  activity: "chat",
  requestId: "request_1",
  streamId: "stream_1",
  runId: "run_1",
  threadId: "thread_1",
  phase: "modelStream",
  iteration: 0,
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
  modelOptions: undefined,
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
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
    expect(events[0]?.properties).not.toHaveProperty("unsafe");
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
      createMiddlewareContext(deferred),
      usage,
    );
    await Promise.all(deferred);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      actionType: "chat",
      isByok: false,
      modelRole: "chat",
      organizationId: orgId,
      periodEnd,
      periodStart,
      serviceTier: "standard",
      traceId: "trace_usage",
      userId,
      workspaceId,
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
      properties: {
        failure_reason: "provider",
        feature: "chat.stream",
        model: "gpt-5.4-mini",
        provider: "openai",
      },
    });
  });
});
